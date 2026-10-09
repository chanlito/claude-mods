import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Cell, Dots, Panel } from "../types";

import {
  applyOverrides,
  composeRows,
  composeState,
  exited127,
  formatStep,
  parseLine,
  parseStack,
  pickStack,
  plan,
  rebase,
  resolvePath,
  stateOfLines,
  statusLine,
  StackError,
  type Observed,
  type Overrides,
  type Prefix,
  type Seen,
  type Service,
  type Stack,
  type Step,
} from "./stack";

/** How often the hint line's dots look again. */
const REFRESH_MS = 30_000;
const TOOL = "dev_up";

/**
 * The machine's boot id (Linux, macOS): a pid written under another boot names
 * some other process, or none. Clock times can't say it: a WSL guest's boot
 * time moves when its clock is corrected after the host sleeps.
 */
const BOOT_ID = String.raw`boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.bootsessionuuid 2>/dev/null)`;

/**
 * Prints `BOOT <id>`, `PORT <n>` per listening TCP port, and `PID <service>
 * alive|dead|stale` per pid file: its process group, or stale when the file is
 * from before the machine last started.
 */
const PROBE = String.raw`
dir="$1"
${BOOT_ID}
[ -n "$boot" ] && echo "BOOT $boot"
if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}'
else lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}'; fi | sed -n 's/.*:\([0-9][0-9]*\)$/PORT \1/p' | sort -u
for f in "$dir"/*.pid; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .pid); p=$(sed -n 1p "$f"); b=$(sed -n 2p "$f")
  if [ -n "$b" ] && [ "$b" != "$boot" ]; then echo "PID $n stale"; continue; fi
  # The group, not only its first process: a watcher outlives the shell it started from.
  if [ -n "$p" ] && { kill -0 "-$p" 2>/dev/null || kill -0 "$p" 2>/dev/null; }; then echo "PID $n alive"; else echo "PID $n dead"; fi
done
`;

/**
 * Starts a command detached, in a session of its own (setsid) so it outlives
 * the turn, the Claude session and a reload of this module, which kills the
 * module's own children. Output goes to the log; the pid to the pid file.
 */
const START = String.raw`
cwd="$1"; cmd="$2"; log="$3"; pidf="$4"
mkdir -p "$(dirname "$log")" || exit 1
cd "$cwd" || { echo "no folder $cwd" >&2; exit 2; }
printf '\n[dev-up] %s  %s\n' "$(date '+%F %T')" "$cmd" >> "$log"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "$cmd" >> "$log" 2>&1 < /dev/null &
else
  nohup sh -c "$cmd" >> "$log" 2>&1 < /dev/null &
fi
p=$!
${BOOT_ID}
printf '%s\n%s\n' "$p" "$boot" > "$pidf"
`;

/**
 * Stops by process group and by port: a dev server's child (a watcher's
 * compiled main) can outlive its parent and keep the port, and a watcher can
 * outlive the TERM that ends the shell it started from. TERM, up to five
 * seconds while anything in the group or on the port lives, then KILL.
 */
const STOP = String.raw`
pidf="$1"; port="$2"; log="$3"
p=""; [ -f "$pidf" ] && p=$(sed -n 1p "$pidf")
# A pid from another boot is some other process now: only the port is stopped.
${BOOT_ID}
[ -f "$pidf" ] && [ -n "$(sed -n 2p "$pidf")" ] && [ "$(sed -n 2p "$pidf")" != "$boot" ] && p=""
holders() {
  [ -n "$port" ] || return 0
  if command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
  else lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null; fi | sort -u
}
alive() { [ -n "$p" ] && { kill -0 "-$p" 2>/dev/null || kill -0 "$p" 2>/dev/null; }; }
[ -n "$p" ] && { kill -TERM "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; }
h=$(holders); [ -n "$h" ] && kill -TERM $h 2>/dev/null
i=0
while [ $i -lt 20 ] && { alive || [ -n "$(holders)" ]; }; do sleep 0.25; i=$((i+1)); done
h=$(holders); [ -n "$h" ] && kill -KILL $h 2>/dev/null
[ -n "$p" ] && { kill -KILL "-$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; }
rm -f "$pidf"
printf '[dev-up] %s  stopped\n' "$(date '+%F %T')" >> "$log"
exit 0
`;

const HELP = [
  "/dev-up                       one pass: start what is down, skip what waits",
  "/dev-up --dry-run             print what a pass would do",
  "/dev-up status                each service's state",
  "/dev-up restart <svc> [args]  stop and start one service; args are added to its command this once",
  "/dev-up stop [<svc>]          stop one service, or every server and task",
  "/dev-up logs <svc> [n]        the last n lines of its log (40)",
  "/dev-up use <dir>             serve the servers of <dir>'s repo from that worktree",
  "/dev-up restore [<svc>]       serve them from their own folders again",
  "/dev-up panel                 every service and the end of its log, in a grid",
].join("\n");

type Run = { exitCode: number; stdout: string; stderr: string };

async function run($: EngineInterface, argv: string[], init: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Run> {
  try {
    return await $.process.run(argv, init);
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

async function homeOf($: EngineInterface) {
  return (await $.env.get("HOME")) ?? "";
}

const expandHome = (path: string, home: string) => path.replace(/^~(?=$|\/)/, home).replace(/\/+$/, "");

/**
 * `stack` is what runs: `base` with `/dev-up use` overrides applied. `base` is
 * the stack file as written, for use and restore.
 */
type Found = { stack?: Stack; base?: Stack; overrides: Overrides; errors: string[]; folder: string; cwd: string };

async function findStack($: EngineInterface, folderSetting: string): Promise<Found> {
  const home = await homeOf($);
  const folder = expandHome(folderSetting, home);
  const cwd = await $.session.cwd();
  const errors: string[] = [];
  const stacks: Stack[] = [];
  const entries = await $.fs.list(folder).catch(() => []);
  for (const entry of entries) {
    if (entry.kind !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const file = `${folder}/${entry.name}`;
    try {
      stacks.push(parseStack(await $.fs.read(file), file, home));
    } catch (error) {
      errors.push(`${file}: ${error instanceof StackError || error instanceof Error ? error.message : String(error)}`);
    }
  }
  const base = pickStack(stacks, cwd);
  if (!base) return { errors, folder, cwd, overrides: {} };
  const overrides = await readOverrides($, home, base);
  return { stack: applyOverrides(base, overrides), base, overrides, errors, folder, cwd };
}

const stateDir = (home: string, stack: Stack) => `${home}/.cache/dev-up/${stack.name}`;
const overridesFile = (home: string, stack: Stack) => `${stateDir(home, stack)}/use.json`;

/** The `/dev-up use` overrides on disk; one whose folder is gone (a removed worktree) is dropped. */
async function readOverrides($: EngineInterface, home: string, stack: Stack): Promise<Overrides> {
  let saved: unknown;
  try {
    saved = JSON.parse(await $.fs.read(overridesFile(home, stack)));
  } catch {
    return {};
  }
  const out: Overrides = {};
  if (!saved || typeof saved !== "object") return out;
  for (const [name, dir] of Object.entries(saved as Record<string, unknown>))
    if (typeof dir === "string" && stack.services.some((s) => s.name === name) && (await $.fs.exists(dir))) out[name] = dir;
  return out;
}

/**
 * A service's checkout: its top folder and the worktrees git lists for its
 * repo. Git runs only in the service's own folder, from the stack file, never
 * in a folder a prompt or the model named: a repo's config can make git run
 * commands.
 */
async function checkoutOf($: EngineInterface, dir: string): Promise<{ top: string; worktrees: string[] } | undefined> {
  const top = await run($, ["git", "-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel"], { timeoutMs: 10_000 });
  const list = await run($, ["git", "-C", dir, "worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
  if (top.exitCode !== 0 || list.exitCode !== 0 || !top.stdout.trim()) return undefined;
  const worktrees = list.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).replace(/\/+$/, ""));
  return { top: top.stdout.trim(), worktrees };
}
const logOf = (home: string, stack: Stack, s: Service) => `${stateDir(home, stack)}/${s.name}.log`;
const pidOf = (home: string, stack: Stack, s: Service) => `${stateDir(home, stack)}/${s.name}.pid`;

const dots = atom({ plugin: "dev-up", key: "dots" } as const, null);

/** Saves what the hint line draws; written only when it changed, so an idle refresh redraws nothing. */
async function show($: EngineInterface, stack: Stack | undefined, seen: Observed = {}) {
  const next: Dots = stack
    ? {
        stack: stack.name,
        services: stack.services.map((s) => ({
          name: s.name,
          state: seen[s.name]?.state ?? "down",
          ...(s.kind === "task" && seen[s.name]?.state === "up" ? { done: true } : {}),
          ...(s.servedFrom ? { from: s.servedFrom } : {}),
        })),
      }
    : null;
  if (JSON.stringify(await read($, dots)) === JSON.stringify(next)) return;
  await update($, dots, () => next);
}

const COLOR = { up: "success", starting: "warning", broken: "error" } as const;
const GLYPH = { up: "●", starting: "◐", down: "○", broken: "✕" } as const;

const checkFile = (home: string, stack: Stack, s: Service) => `${stateDir(home, stack)}/${s.name}.check`;

/** This boot's id, or undefined where the machine gives none. */
async function bootId($: EngineInterface): Promise<string | undefined> {
  const r = await run($, ["sh", "-c", `${BOOT_ID}\necho "$boot"`], { timeoutMs: 5_000 });
  return r.stdout.trim() || undefined;
}

/**
 * What a check script last said, kept on disk so a reload and every other
 * session see it too. One said before the machine last started is no answer.
 */
async function savedCheck($: EngineInterface, home: string, stack: Stack, s: Service, boot?: string): Promise<Seen | undefined> {
  try {
    const saved = JSON.parse(await $.fs.read(checkFile(home, stack, s))) as Seen & { boot?: string };
    if (boot && saved.boot && saved.boot !== boot) return undefined;
    delete saved.boot;
    return ["up", "starting", "down", "broken"].includes(saved.state) ? saved : undefined;
  } catch {
    return undefined;
  }
}

async function observe($: EngineInterface, stack: Stack): Promise<Observed> {
  const home = await homeOf($);
  const probe = await run($, ["sh", "-c", PROBE, "sh", stateDir(home, stack)], { timeoutMs: 10_000 });
  const ports = new Set<number>();
  // A pid file from before a reboot (stale) says nothing: that service is simply down.
  const pids = new Map<string, boolean>();
  let boot: string | undefined;
  for (const line of probe.stdout.split("\n")) {
    const [kind, a, b] = line.trim().split(/\s+/);
    if (kind === "PORT") ports.add(Number(a));
    if (kind === "PID" && a && b !== "stale") pids.set(a, b === "alive");
    if (kind === "BOOT" && a) boot = a;
  }

  const seen: Observed = {};
  await Promise.all(
    stack.services.map(async (s) => {
      const log = logOf(home, stack, s);
      const alive = pids.get(s.name);
      let entry: Seen;
      if (s.kind === "compose") {
        const ps = await run($, ["docker", "compose", "ps", "-a", "--format", "json"], { cwd: s.dir, timeoutMs: 20_000 });
        if (ps.exitCode !== 0)
          entry = {
            state: "broken",
            why: /cannot connect|daemon|docker\.sock|not running/i.test(ps.stderr)
              ? "Docker is not running: start it, then run /dev-up again"
              : `docker compose ps failed: ${lastLine(ps.stderr)}`,
          };
        else {
          try {
            entry = composeState(s, ps.stdout, await exitErrors($, s, ps.stdout));
          } catch {
            entry = { state: "broken", why: "could not read docker compose ps" };
          }
        }
      } else if (s.kind === "check") {
        // Between passes: the probe, if the stack gives one, beside what the script last said.
        const saved = await savedCheck($, home, stack, s, boot);
        if (!s.probe) entry = saved ?? { state: "down" };
        else {
          const ok = (await run($, ["sh", "-c", s.probe], { cwd: stack.root, timeoutMs: 10_000 })).exitCode === 0;
          entry = ok
            ? saved?.state === "broken" ? saved : { state: "up" }
            : saved?.state === "starting" ? saved : { state: "down" };
        }
      } else if (s.kind === "task") {
        if (await $.fs.exists(s.creates!)) entry = { state: "up" };
        else if (alive === true) entry = { state: "starting" };
        else if (alive === false) entry = { state: "broken", why: `exited without making ${s.creates}; log: ${log}` };
        else entry = { state: "down" };
      } else {
        if (s.port ? ports.has(s.port) : alive === true) entry = { state: "up" };
        else if (alive === true) entry = { state: "starting" };
        else if (alive === false) entry = { state: "broken", why: `exited since it was started; log: ${log}` };
        else entry = { state: "down" };
      }
      if ((s.kind === "server" || s.kind === "task") && entry.state !== "up" && (await $.fs.exists(`${s.dir}/package.json`)))
        entry.needsInstall = await installGap($, s.dir);
      seen[s.name] = entry;
    }),
  );
  return seen;
}

/** Why each container that exited 127 did, from Docker: `.State.Error` by compose service. */
async function exitErrors($: EngineInterface, s: Service, psJson: string): Promise<Record<string, string>> {
  const ids = exited127(composeRows(psJson))
    .map((r) => r.ID)
    .filter((id): id is string => !!id);
  if (!ids.length) return {};
  const format = '{{index .Config.Labels "com.docker.compose.service"}}{{"\\t"}}{{.State.Error}}';
  const r = await run($, ["docker", "inspect", "--format", format, ...ids], { cwd: s.dir, timeoutMs: 20_000 });
  const errors: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const [service, ...error] = line.split("\t");
    if (service && error.join("\t").trim()) errors[service] = error.join("\t").trim();
  }
  return errors;
}

/** One shell word, quoted so the shell reads it as text and runs nothing in it. */
const shellWord = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * `extra` is added to the command for this start only (`-- --clear`), each word
 * quoted: it comes from a prompt or the model's tool call, never from the stack file.
 */
/**
 * Why `dir` needs an install before it can start, if it does: no node_modules,
 * or a lockfile newer than the install npm last recorded (a pull added a package).
 */
async function installGap($: EngineInterface, dir: string): Promise<string | undefined> {
  if (!(await $.fs.exists(`${dir}/node_modules`))) return `no node_modules in ${dir}`;
  const stat = (path: string) => $.fs.stat(path).catch(() => undefined);
  const [lock, installed] = await Promise.all([stat(`${dir}/package-lock.json`), stat(`${dir}/node_modules/.package-lock.json`)]);
  if (lock && installed && lock.mtimeMs > installed.mtimeMs) return `package-lock.json in ${dir} changed since the last npm install`;
  return undefined;
}

async function start($: EngineInterface, stack: Stack, s: Service, extra = ""): Promise<Run> {
  const home = await homeOf($);
  const words = extra.split(/\s+/).filter(Boolean).map(shellWord);
  const command = [s.kind === "task" ? s.task! : s.run!, ...words].join(" ");
  return run($, ["sh", "-c", START, "sh", s.dir, command, logOf(home, stack, s), pidOf(home, stack, s)]);
}

async function stop($: EngineInterface, stack: Stack, s: Service): Promise<Run> {
  const home = await homeOf($);
  return run($, ["sh", "-c", STOP, "sh", pidOf(home, stack, s), s.port ? String(s.port) : "", logOf(home, stack, s)], { timeoutMs: 15_000 });
}

/** Runs a check script; its UP / STARTED / SKIP / WARN lines are relayed under the service's name. */
async function runCheck($: EngineInterface, stack: Stack, s: Service, dryRun: boolean): Promise<{ lines: string[]; seen: Seen }> {
  const r = await run($, dryRun ? [s.check!, "--dry-run"] : [s.check!], {
    cwd: stack.root,
    timeoutMs: 300_000,
    env: { DEV_UP_STACK: stack.name, DEV_UP_ROOT: stack.root },
  });
  const lines: string[] = [];
  const prefixes: Prefix[] = [];
  for (const raw of r.stdout.split("\n")) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (line) {
      prefixes.push(line.prefix);
      lines.push(formatStep({ prefix: line.prefix, text: `${s.name}: ${line.text}` }));
    } else lines.push(`${" ".repeat(8)}${raw.trimEnd()}`);
  }
  if (r.exitCode !== 0 && prefixes.length === 0) {
    prefixes.push("WARN");
    lines.push(formatStep({ prefix: "WARN", text: `${s.name}: ${s.check} exited ${r.exitCode}: ${lastLine(r.stderr) || "no output"}` }));
  }
  const seen: Seen = { state: stateOfLines(prefixes) };
  // The lines too, for the panel: a check script keeps no log of its own.
  const boot = await bootId($);
  const saved = { ...seen, ...(boot ? { boot } : {}), lines: r.stdout.split("\n").filter((l) => l.trim()).slice(-PANEL_LINES) };
  if (!dryRun) await $.fs.write(checkFile(await homeOf($), stack, s), `${JSON.stringify(saved)}\n`).catch(() => {});
  return { lines, seen };
}

async function report($: EngineInterface, stack: Stack): Promise<string | undefined> {
  if (stack.report.length === 0) return undefined;
  const codes = await Promise.all(
    stack.report.map(async ({ name, url }) => {
      const r = await run($, ["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", url], { timeoutMs: 6_000 });
      return `${name} ${r.stdout.trim() || "000"}`;
    }),
  );
  return `${"report".padEnd(8)}${codes.join("  ")}`;
}

async function pass($: EngineInterface, stack: Stack, dryRun: boolean): Promise<{ lines: string[]; seen: Observed }> {
  const home = await homeOf($);
  const seen = await observe($, stack);
  const steps: Step[] = plan(stack, seen);
  const lines: string[] = [];
  for (const step of steps) {
    const s = stack.services.find((x) => x.name === step.service)!;
    if (!step.action) {
      lines.push(formatStep(step));
      continue;
    }
    if (step.action === "check") {
      const checked = await runCheck($, stack, s, dryRun);
      lines.push(...checked.lines);
      if (!dryRun) seen[s.name] = checked.seen;
      continue;
    }
    if (dryRun) {
      const what = step.command ? step.command.join(" ") : step.text.slice(s.name.length + 2);
      lines.push(formatStep({ prefix: "ACTION", text: `${s.name}: ${what}  (in ${s.dir})` }));
      continue;
    }
    const r = step.command ? await run($, step.command, { cwd: s.dir, timeoutMs: 300_000 }) : await start($, stack, s);
    if (r.exitCode === 0) {
      const where = step.action === "start" ? `  (log ${logOf(home, stack, s)})` : "";
      lines.push(formatStep({ prefix: "STARTED", text: `${step.text}${where}` }));
      seen[s.name] = { state: "starting" };
    } else lines.push(formatStep({ prefix: "WARN", text: `${s.name}: could not start: ${lastLine(r.stderr) || `exit ${r.exitCode}`}` }));
  }
  const reported = dryRun ? undefined : await report($, stack);
  if (reported) lines.push(reported);
  if (stack.notes && lines.some((l) => /^(WARN|STOP)\s/.test(l))) lines.push(`Notes for this stack: ${stack.notes}`);
  return { lines, seen };
}

function serviceOf(stack: Stack, name: string | undefined): Service | string {
  if (!name) return `Name a service: ${stack.services.map((s) => s.name).join(", ")}.`;
  return stack.services.find((s) => s.name === name) ?? `No service "${name}" in ${stack.name}. It has ${stack.services.map((s) => s.name).join(", ")}.`;
}

/** The whole command, shared by /dev-up and the model's tool. */
async function dispatch($: EngineInterface, folderSetting: string, args: string): Promise<string> {
  const found = await findStack($, folderSetting);
  const { stack } = found;
  const broken = found.errors.length ? `\n\nStack files that did not load:\n${found.errors.join("\n")}` : "";
  if (!stack)
    return `No stack covers ${found.cwd}. A stack is ${found.folder}/<name>.yml with a root: that holds this folder.${broken}`;

  const words = args.trim().split(/\s+/).filter(Boolean);
  const [verb = "", name, extra] = words;
  /** Everything after the service's name, for restart. */
  const rest = words.slice(2).join(" ");
  const home = await homeOf($);

  if (verb === "" || verb === "up" || verb === "--dry-run" || verb === "dry-run") {
    const dryRun = verb !== "" && verb !== "up";
    const { lines, seen } = await pass($, stack, dryRun);
    if (!dryRun) await show($, stack, seen);
    return [...lines, "", statusLine(stack, seen)].join("\n") + broken;
  }
  if (verb === "status") {
    const seen = await observe($, stack);
    await show($, stack, seen);
    return stack.services
      .map(
        (s) =>
          `${(seen[s.name]?.state ?? "down").padEnd(9)}${s.name}${s.servedFrom ? `  from ${s.dir}` : ""}${seen[s.name]?.why ? `  ${seen[s.name]!.why}` : ""}`,
      )
      .join("\n");
  }
  if (verb === "help") return HELP;
  if (verb === "panel") {
    await openPanel($, folderSetting);
    return "Opened the dev stack panel: every service and the end of its log, refreshed every 3 seconds.";
  }
  if (verb === "logs") {
    const s = serviceOf(stack, name);
    if (typeof s === "string") return s;
    const n = String(Math.min(500, Math.max(1, Number(extra) || 40)));
    if (s.kind === "check") return `${s.name} is a check script; it keeps no log. Run /dev-up to see what it says.`;
    const r =
      s.kind === "compose"
        ? await run($, ["docker", "compose", "logs", "--no-color", "--tail", n], { cwd: s.dir })
        : await run($, ["tail", "-n", n, logOf(home, stack, s)]);
    return r.exitCode === 0 ? r.stdout.trimEnd() || "(empty)" : `No log for ${s.name} yet.`;
  }
  if (verb === "stop") {
    if (!name) {
      const targets = stack.services.filter((s) => s.kind === "server" || s.kind === "task");
      for (const s of targets) await stop($, stack, s);
      return `Stopped ${targets.map((s) => s.name).join(", ")}. Containers are left running.`;
    }
    const s = serviceOf(stack, name);
    if (typeof s === "string") return s;
    if (s.kind === "check") return `${s.name} is a check script; there is nothing to stop.`;
    if (s.kind === "compose") {
      const r = await run($, ["docker", "compose", "stop"], { cwd: s.dir, timeoutMs: 120_000 });
      return r.exitCode === 0 ? `Stopped ${s.name}'s containers.` : `docker compose stop failed: ${lastLine(r.stderr)}`;
    }
    await stop($, stack, s);
    return `Stopped ${s.name}.`;
  }
  if (verb === "use" || verb === "restore") {
    const base = found.base!;
    const next: Overrides = { ...found.overrides };
    if (verb === "use") {
      if (!name) return "Name the worktree: /dev-up use <dir>.";
      const target = resolvePath(name, found.cwd, home);
      let matched = 0;
      for (const s of base.services) {
        if (s.kind !== "server" && s.kind !== "task") continue;
        const own = await checkoutOf($, s.dir);
        // Only a worktree git lists for this service's repo, the deepest that holds the target.
        const into = own?.worktrees
          .filter((w) => target === w || target.startsWith(`${w}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (!own || !into) continue;
        const dir = rebase(s.dir, own.top, into);
        if (!dir) continue;
        matched++;
        if (dir === s.dir) delete next[s.name];
        else next[s.name] = dir;
      }
      if (!matched) return `${target} is not a worktree of any repo a server or task in ${base.name} runs from (git worktree list).`;
    } else if (name) {
      if (!(name in next)) return `${name} is served from its own folder already.`;
      delete next[name];
    } else for (const k of Object.keys(next)) delete next[k];

    await $.fs.write(overridesFile(home, base), `${JSON.stringify(next, null, 2)}\n`);
    const after = applyOverrides(base, next);
    const seen = await observe($, after);
    const lines: string[] = [];
    for (const s of after.services) {
      const was = stack.services.find((x) => x.name === s.name)!;
      if (was.dir === s.dir) continue;
      await stop($, stack, was);
      const waiting = s.after.filter((d) => seen[d]?.state !== "up");
      if (waiting.length) {
        lines.push(formatStep({ prefix: "SKIP", text: `${s.name}: now from ${s.dir}; waits for ${waiting.join(", ")}, so the next /dev-up starts it` }));
        continue;
      }
      const r = await start($, after, s);
      lines.push(
        r.exitCode === 0
          ? formatStep({ prefix: "STARTED", text: `${s.name}: from ${s.dir}  (log ${logOf(home, after, s)})` })
          : formatStep({ prefix: "WARN", text: `${s.name}: stopped, but it did not start from ${s.dir}: ${lastLine(r.stderr)}` }),
      );
      seen[s.name] = { state: "starting" };
    }
    if (!lines.length) lines.push(verb === "use" ? "Already served from there." : "Nothing was moved.");
    await show($, after, seen);
    return [...lines, "", statusLine(after, seen)].join("\n");
  }
  if (verb === "restart") {
    const s = serviceOf(stack, name);
    if (typeof s === "string") return s;
    if (s.kind === "compose") {
      if (rest) return `${s.name} is containers; restart takes no extra arguments for it.`;
      const r = await run($, ["docker", "compose", "up", "-d", "--force-recreate"], { cwd: s.dir, timeoutMs: 300_000 });
      return r.exitCode === 0 ? `Recreated ${s.name}'s containers. Run /dev-up once they are healthy.` : `Recreate failed: ${lastLine(r.stderr)}`;
    }
    if (s.kind === "check") {
      if (rest) return `${s.name} is a check script; restart takes no extra arguments for it.`;
      return (await runCheck($, stack, s, false)).lines.join("\n");
    }
    const seen = await observe($, stack);
    const waiting = s.after.filter((d) => seen[d]?.state !== "up");
    if (waiting.length) return `${s.name} waits for ${waiting.join(", ")}, which is not up. Run /dev-up first.`;
    await stop($, stack, s);
    const r = await start($, stack, s, rest);
    return r.exitCode === 0
      ? `Restarted ${s.name}${rest ? ` with ${rest}` : ""}  (log ${logOf(home, stack, s)})`
      : `Stopped ${s.name}, but it did not start: ${lastLine(r.stderr)}`;
  }
  return `Unknown: ${verb}\n\n${HELP}`;
}

/* ---- /dev-up panel ---- */

const PANE = "dev-up";
const PANEL_MS = 3_000;
const PANEL_LINES = 40;
const panel = atom({ plugin: "dev-up", key: "panel" } as const, null);
let panelTimer: { cancel: () => void } | undefined;
let filling = false;

/** A log line as text: colors, cursor moves and carriage returns taken out. */
const plain = (line: string) =>
  line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "");

async function logLines($: EngineInterface, home: string, stack: Stack, s: Service): Promise<string[]> {
  const n = String(PANEL_LINES);
  if (s.kind === "check") {
    try {
      const saved = JSON.parse(await $.fs.read(checkFile(home, stack, s))) as { lines?: string[] };
      return saved.lines?.length ? saved.lines : ["(no output yet)"];
    } catch {
      return ["(not run yet: /dev-up runs it)"];
    }
  }
  const r =
    s.kind === "compose"
      ? await run($, ["docker", "compose", "logs", "--no-color", "--tail", n], { cwd: s.dir, timeoutMs: 10_000 })
      : await run($, ["tail", "-n", n, logOf(home, stack, s)], { timeoutMs: 5_000 });
  if (r.exitCode !== 0) return [s.kind === "compose" ? "(docker compose logs failed)" : "(no log: not started by /dev-up)"];
  const lines = r.stdout.split("\n").map(plain).filter((l) => l.trim());
  return lines.length ? lines : ["(empty)"];
}

const detailOf = (s: Service) => (s.kind === "server" ? (s.port ? `:${s.port}` : "server") : s.kind === "compose" ? "docker" : s.kind);

/** Refills the panel's cells; written only when something changed. */
async function fillPanel($: EngineInterface, folderSetting: string) {
  if (filling) return;
  filling = true;
  try {
    const { stack } = await findStack($, folderSetting);
    let next: Panel = { stack: "", cells: [] };
    if (stack) {
      const home = await homeOf($);
      const seen = await observe($, stack);
      const cells: Cell[] = await Promise.all(
        stack.services.map(async (s) => {
          const state = seen[s.name]?.state ?? "down";
          return {
            name: s.name,
            kind: s.kind,
            state,
            ...(s.kind === "task" && state === "up" ? { done: true as const } : {}),
            ...(s.servedFrom ? { from: s.servedFrom } : {}),
            detail: detailOf(s),
            lines: await logLines($, home, stack, s),
          };
        }),
      );
      next = { stack: stack.name, cells };
      await show($, stack, seen);
    }
    if (JSON.stringify(await read($, panel)) !== JSON.stringify(next)) await update($, panel, () => next);
  } catch {
    // The next tick tries again.
  } finally {
    filling = false;
  }
}

async function openPanel($: EngineInterface, folderSetting: string) {
  await $.ui.open({ id: PANE, title: "Dev stack" });
  await fillPanel($, folderSetting);
  panelTimer ??= $.clock.every(PANEL_MS, () => {
    void (async () => {
      if (!(await $.ui.panes()).some((p) => p.id === PANE)) {
        panelTimer?.cancel();
        panelTimer = undefined;
        return;
      }
      await fillPanel($, folderSetting);
    })();
  });
}

let refreshing = false;

async function refresh($: EngineInterface, folderSetting: string) {
  if (refreshing) return;
  refreshing = true;
  try {
    const { stack } = await findStack($, folderSetting);
    await show($, stack, stack ? await observe($, stack) : {});
  } catch {
    // A refresh in the background has nobody to tell; the next one, or a command, tries again.
  } finally {
    refreshing = false;
  }
}

export const register: Register = (on, options) => {
  const folderSetting = String(options.stacks ?? "~/.claude/dev-stacks");

  /** Set when another /dev-up (a skill, a command file) holds the name: that one answers it. */
  let commandTaken = false;

  on("session.start", async ($, e, next) => {
    // Versions before the dots pinned a plain status line; a pinned line outlives a reload.
    $.ui.status(undefined);
    try {
      await $.command.register({
        name: "dev-up",
        description: "Bring up this folder's dev stack: start what is down, skip what waits",
        argumentHint: "[panel|status|restart <svc> [args]|stop [<svc>]|logs <svc>|use <dir>|restore|--dry-run]",
      });
    } catch (error) {
      commandTaken = true;
      $.ui.log(`dev-up: /dev-up is taken (${error instanceof Error ? error.message : String(error)}); the dev_up tool and the dots under the prompt still work`);
    }
    await $.tool.register({
      name: TOOL,
      description:
        "The dev stack for the session's folder, from ~/.claude/dev-stacks/<name>.yml. " +
        "action=up runs one pass and returns at once: it starts what is down and skips what waits on something still starting. " +
        "Call up again later to finish a pass that skipped things; never start these servers from Bash, where they die with the turn. " +
        "status reports each service; restart and stop take a service; logs prints its last lines. " +
        "use serves the servers of a worktree's repo from that worktree (dir), for every session; restore puts them back.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["up", "status", "restart", "stop", "logs", "dry-run", "use", "restore"] },
          service: { type: "string", description: "The service, for restart, stop and logs." },
          lines: { type: "number", description: "For logs: how many lines (40)." },
          dir: { type: "string", description: "For use: the worktree to serve its repo's servers from." },
          args: { type: "string", description: "For restart: added to the service's command for this start only, e.g. \"-- --clear\"." },
        },
        required: ["action"],
      },
    });
    void refresh($, folderSetting);
    $.clock.every(REFRESH_MS, () => void refresh($, folderSetting));
    return next(e);
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE) {
      panelTimer?.cancel();
      panelTimer = undefined;
    }
    return next(e);
  });

  // The panel: one bordered cell per service, its state on the frame, the end of its log inside.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const p = await read($, panel);
    if (!p) return <Text dimColor>Looking at the stack…</Text>;
    if (!p.cells.length) return <Text dimColor>No stack covers this folder. A stack is ~/.claude/dev-stacks/name.yml.</Text>;
    const width = Math.max(20, e.props.bodyColumns);
    const cols = width >= 150 ? 3 : width >= 90 ? 2 : 1;
    const cellWidth = Math.floor((width - (cols - 1)) / cols);
    const gridRows = Math.ceil(p.cells.length / cols);
    const logRows = Math.max(3, Math.min(30, Math.floor(e.props.scroll.bodyRows / gridRows) - 3));
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {p.cells.map((c) => (
          <Box
            key={`cell-${c.name}`}
            width={cellWidth}
            height={logRows + 3}
            flexDirection="column"
            borderStyle="round"
            {...(c.state === "down" ? { borderDimColor: true } : { borderColor: COLOR[c.state] })}
            overflow="hidden"
          >
            <Box flexDirection="row" gap={1}>
              {c.state === "down" ? (
                <Text dimColor>{GLYPH.down}</Text>
              ) : (
                <Text color={COLOR[c.state]}>{c.done ? "✓" : GLYPH[c.state]}</Text>
              )}
              <Text bold>
                {c.name}
                {c.from ? `@${c.from}` : ""}
              </Text>
              <Text dimColor>{c.detail}</Text>
              {(c.kind === "server" || c.kind === "task") && (
                <Button
                  key={`restart-${c.name}`}
                  label="restart"
                  plain
                  dimColor
                  onPress={() =>
                    void (async () => {
                      const out = await dispatch($, folderSetting, `restart ${c.name}`);
                      $.ui.toast(out.split("\n")[0] ?? out);
                      await fillPanel($, folderSetting);
                    })()
                  }
                />
              )}
            </Box>
            {c.lines.slice(-logRows).map((line, i) => (
              <Text key={`log-${c.name}-${i}`} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  });

  // The stack's dots, colored, at the end of the hint line under the prompt.
  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const d = await read($, dots);
    if (!d) return next(e);
    const own = await next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="row" gap={2}>
        {own}
        <Box key="dev-up" flexDirection="row" gap={1}>
          <Text dimColor>dev</Text>
          {d.services.map((s) => (
            <Box key={`dev-up-${s.name}`} flexDirection="row">
              {s.state === "down" ? (
                <Text dimColor>{GLYPH.down}</Text>
              ) : (
                <Text color={COLOR[s.state]}>{s.done ? "✓" : GLYPH[s.state]}</Text>
              )}
              <Text dimColor>
                {" "}
                {s.name}
                {s.from ? `@${s.from}` : ""}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  });

  on("command.run", { command: "dev-up" }, async ($, e, next) =>
    commandTaken ? next(e) : { text: await dispatch($, folderSetting, e.args) },
  );

  on("tool.call", { tool: "mcp__dev-up__dev_up" }, async ($, e) => {
    const input = e as unknown as { action?: string; service?: string; lines?: number; args?: string; dir?: string };
    const extra = input.action === "restart" ? (input.args ?? "") : input.lines ? String(input.lines) : "";
    const target = input.action === "use" ? (input.dir ?? input.service ?? "") : (input.service ?? "");
    const args = [input.action ?? "up", target, extra].join(" ");
    return { result: await dispatch($, folderSetting, args) };
  });
};
