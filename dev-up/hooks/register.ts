import type { EngineInterface, Register } from "claude-code";

import {
  applyOverrides,
  composeState,
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

/** How often the status line looks again. */
const REFRESH_MS = 30_000;
const TOOL = "dev_up";

/** Prints `PORT <n>` per listening TCP port and `PID <service> alive|dead` per pid file (its process group). */
const PROBE = String.raw`
dir="$1"
if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}'
else lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}'; fi | sed -n 's/.*:\([0-9][0-9]*\)$/PORT \1/p' | sort -u
for f in "$dir"/*.pid; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .pid); p=$(cat "$f")
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
echo $! > "$pidf"
`;

/**
 * Stops by process group and by port: a dev server's child (a watcher's
 * compiled main) can outlive its parent and keep the port, and a watcher can
 * outlive the TERM that ends the shell it started from. TERM, up to five
 * seconds while anything in the group or on the port lives, then KILL.
 */
const STOP = String.raw`
pidf="$1"; port="$2"; log="$3"
p=""; [ -f "$pidf" ] && p=$(cat "$pidf")
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

/** A folder's checkout: its top folder and the git folder all its worktrees share. */
async function checkoutOf($: EngineInterface, dir: string): Promise<{ top: string; common: string } | undefined> {
  const r = await run($, ["git", "-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { timeoutMs: 10_000 });
  const [top, common] = r.stdout.trim().split("\n");
  return r.exitCode === 0 && top && common ? { top, common } : undefined;
}
const logOf = (home: string, stack: Stack, s: Service) => `${stateDir(home, stack)}/${s.name}.log`;
const pidOf = (home: string, stack: Stack, s: Service) => `${stateDir(home, stack)}/${s.name}.pid`;

/** What each check script last said, by `<stack>/<service>`; scripts run only on a pass. */
const checks = new Map<string, Seen>();

async function observe($: EngineInterface, stack: Stack): Promise<Observed> {
  const home = await homeOf($);
  const probe = await run($, ["sh", "-c", PROBE, "sh", stateDir(home, stack)], { timeoutMs: 10_000 });
  const ports = new Set<number>();
  const pids = new Map<string, boolean>();
  for (const line of probe.stdout.split("\n")) {
    const [kind, a, b] = line.trim().split(/\s+/);
    if (kind === "PORT") ports.add(Number(a));
    if (kind === "PID" && a) pids.set(a, b === "alive");
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
            entry = composeState(s, ps.stdout);
          } catch {
            entry = { state: "broken", why: "could not read docker compose ps" };
          }
        }
      } else if (s.kind === "check") {
        entry = checks.get(`${stack.name}/${s.name}`) ?? { state: "down" };
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
async function runCheck($: EngineInterface, stack: Stack, s: Service, dryRun: boolean): Promise<string[]> {
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
  if (!dryRun) checks.set(`${stack.name}/${s.name}`, { state: stateOfLines(prefixes) });
  return lines;
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
      lines.push(...(await runCheck($, stack, s, dryRun)));
      if (!dryRun) seen[s.name] = checks.get(`${stack.name}/${s.name}`)!;
      continue;
    }
    if (dryRun) {
      const what = step.action === "compose" ? `docker compose up -d  (in ${s.dir})` : `${step.text.slice(s.name.length + 2)}  (in ${s.dir})`;
      lines.push(formatStep({ prefix: "ACTION", text: `${s.name}: ${what}` }));
      continue;
    }
    const r =
      step.action === "compose"
        ? await run($, ["docker", "compose", "up", "-d"], { cwd: s.dir, timeoutMs: 300_000 })
        : await start($, stack, s);
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
    if (!dryRun) $.ui.status(statusLine(stack, seen));
    return [...lines, "", statusLine(stack, seen)].join("\n") + broken;
  }
  if (verb === "status") {
    const seen = await observe($, stack);
    $.ui.status(statusLine(stack, seen));
    return stack.services
      .map(
        (s) =>
          `${(seen[s.name]?.state ?? "down").padEnd(9)}${s.name}${s.servedFrom ? `  from ${s.dir}` : ""}${seen[s.name]?.why ? `  ${seen[s.name]!.why}` : ""}`,
      )
      .join("\n");
  }
  if (verb === "help") return HELP;
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
      const into = await checkoutOf($, target);
      if (!into) return `${target} is not a git checkout.`;
      let matched = 0;
      for (const s of base.services) {
        if (s.kind !== "server" && s.kind !== "task") continue;
        const own = await checkoutOf($, s.dir);
        if (!own || own.common !== into.common) continue;
        const dir = rebase(s.dir, own.top, into.top);
        if (!dir) continue;
        matched++;
        if (dir === s.dir) delete next[s.name];
        else next[s.name] = dir;
      }
      if (!matched) return `No server or task in ${base.name} runs from ${into.top}'s repo.`;
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
    $.ui.status(statusLine(after, seen));
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
      return (await runCheck($, stack, s, false)).join("\n");
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

let refreshing = false;

async function refresh($: EngineInterface, folderSetting: string) {
  if (refreshing) return;
  refreshing = true;
  try {
    const { stack } = await findStack($, folderSetting);
    $.ui.status(stack ? statusLine(stack, await observe($, stack)) : undefined);
  } finally {
    refreshing = false;
  }
}

export const register: Register = (on, options) => {
  const folderSetting = String(options.stacks ?? "~/.claude/dev-stacks");

  /** Set when another /dev-up (a skill, a command file) holds the name: that one answers it. */
  let commandTaken = false;

  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "dev-up",
        description: "Bring up this folder's dev stack: start what is down, skip what waits",
        argumentHint: "[status|restart <svc> [args]|stop [<svc>]|logs <svc>|use <dir>|restore|--dry-run]",
      });
    } catch (error) {
      commandTaken = true;
      $.ui.log(`dev-up: /dev-up is taken (${error instanceof Error ? error.message : String(error)}); the dev_up tool and the status line still work`);
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
