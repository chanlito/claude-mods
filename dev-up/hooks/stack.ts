/**
 * A stack file, and what one pass of /dev-up does with it. Everything here is
 * pure: the hooks module observes the machine, asks `plan` what to do, and
 * does it. Nothing in this file names a project.
 */
import { parseYaml } from "./yaml";

export type Kind = "compose" | "server" | "task" | "check";

export type Service = {
  name: string;
  kind: Kind;
  /** Services that must be up before this one starts. */
  after: string[];
  /** Folder the command runs in, absolute (from `cwd` or `compose`). */
  dir: string;
  /** compose: the containers that must report healthy, and that must be running. */
  healthy: string[];
  running: string[];
  /** server: the command and the port that says it is up. */
  run?: string;
  port?: number;
  /** task: the command and the path whose presence says it is done. */
  task?: string;
  creates?: string;
  /** check: the script, absolute, and an optional read-only command whose exit 0 says it is up. */
  check?: string;
  probe?: string;
  /** Set when `/dev-up use` moved this service onto another checkout: that checkout's folder name. */
  servedFrom?: string;
};

export type Stack = {
  name: string;
  /** The stack file, and the folder that holds it. */
  file: string;
  /** The folder the stack covers; a session under it uses this stack. */
  root: string;
  notes?: string;
  services: Service[];
  report: { name: string; url: string }[];
};

export class StackError extends Error {}

const NAME = /^[A-Za-z0-9_.-]+$/;

const dirOf = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** `~` to home, then relative to `base`; no trailing slash. */
export function resolvePath(path: string, base: string, home: string): string {
  const expanded = path.replace(/^~(?=$|\/)/, home);
  const absolute = expanded.startsWith("/") ? expanded : `${base}/${expanded}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const list = (value: unknown, what: string): string[] => {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new StackError(`${what} must be a name or a list of names`);
};

const text = (value: unknown, what: string): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new StackError(`${what} must be text`);
};

export function parseStack(source: string, file: string, home: string): Stack {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (error) {
    throw new StackError(error instanceof Error ? error.message : String(error));
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new StackError("the file is not a map");
  const d = doc as Record<string, unknown>;

  const name = text(d.name, "name") ?? file.split("/").at(-1)!.replace(/\.ya?ml$/, "");
  if (!NAME.test(name)) throw new StackError(`name: "${name}" must be letters, digits, . _ - (it names a folder)`);
  const here = dirOf(file);
  const rootText = text(d.root, "root");
  if (!rootText) throw new StackError("root: is missing (the folder this stack covers)");
  const root = resolvePath(rootText, here, home);

  if (!d.services || typeof d.services !== "object" || Array.isArray(d.services))
    throw new StackError("services: is missing, or not a map");
  const given = d.services as Record<string, unknown>;

  const services = new Map<string, Service>();
  for (const [key, raw] of Object.entries(given)) {
    if (!NAME.test(key)) throw new StackError(`"${key}": a service name is letters, digits, . _ -`);
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s !== "object" || Array.isArray(s)) throw new StackError(`${key}: must be a map`);
    const kinds = (["compose", "run", "task", "check"] as const).filter((k) => s[k] != null);
    if (kinds.length !== 1)
      throw new StackError(`${key}: needs exactly one of compose, run, task or check (found ${kinds.join(", ") || "none"})`);
    const kind: Kind = kinds[0] === "run" ? "server" : kinds[0]!;
    const cwd = text(s.cwd, `${key}.cwd`);
    const port = s.port == null ? undefined : Number(s.port);
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
      throw new StackError(`${key}.port must be a port number`);
    const ready = (s.ready ?? {}) as Record<string, unknown>;
    if (typeof ready !== "object" || Array.isArray(ready)) throw new StackError(`${key}.ready must be a map`);
    const service: Service = {
      name: key,
      kind,
      after: list(s.after, `${key}.after`),
      dir: resolvePath(kind === "compose" ? text(s.compose, `${key}.compose`)! : (cwd ?? "."), root, home),
      healthy: list(ready.healthy, `${key}.ready.healthy`),
      running: list(ready.up, `${key}.ready.up`),
    };
    if (kind === "server") {
      service.run = text(s.run, `${key}.run`);
      service.port = port;
    }
    if (kind === "task") {
      service.task = text(s.task, `${key}.task`);
      const creates = text(s.creates, `${key}.creates`);
      if (!creates) throw new StackError(`${key}: a task needs creates: (the path that says it is done)`);
      service.creates = resolvePath(creates, service.dir, home);
    }
    if (kind === "check") {
      service.check = resolvePath(text(s.check, `${key}.check`)!, here, home);
      service.probe = text(s.probe, `${key}.probe`);
    } else if (s.probe != null) throw new StackError(`${key}: probe: is for a check service`);
    services.set(key, service);
  }
  if (services.size === 0) throw new StackError("services: lists nothing");

  for (const s of services.values())
    for (const dep of s.after)
      if (!services.has(dep)) throw new StackError(`${s.name} waits for "${dep}", which is not a service`);

  // Dependencies first, file order otherwise.
  const ordered: Service[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (s: Service) => {
    if (done.has(s.name)) return;
    if (visiting.has(s.name)) throw new StackError(`${s.name} waits for itself, through after:`);
    visiting.add(s.name);
    for (const dep of s.after) visit(services.get(dep)!);
    visiting.delete(s.name);
    done.add(s.name);
    ordered.push(s);
  };
  for (const s of services.values()) visit(s);

  const reportRaw = d.report ?? {};
  if (typeof reportRaw !== "object" || Array.isArray(reportRaw)) throw new StackError("report: must be a map of name: url");
  const report = Object.entries(reportRaw as Record<string, unknown>).map(([k, v]) => ({
    name: k,
    url: text(v, `report.${k}`) ?? "",
  }));

  const notes = text(d.notes, "notes");
  return { name, file, root, notes: notes && resolvePath(notes, here, home), services: ordered, report };
}

/** The stack whose root holds `cwd`, the deepest root winning. */
export function pickStack(stacks: Stack[], cwd: string): Stack | undefined {
  return stacks
    .filter((s) => cwd === s.root || cwd.startsWith(`${s.root}/`) || s.root === "/")
    .sort((a, b) => b.root.length - a.root.length)[0];
}

export type State = "down" | "starting" | "up" | "broken";
/** `needsInstall` says why the folder needs an install before it can start. */
export type Seen = { state: State; why?: string; needsInstall?: string };
export type Observed = Record<string, Seen>;

export type Prefix = "UP" | "STARTED" | "SKIP" | "WARN" | "STOP" | "ACTION";
export type Action = "compose" | "start" | "check";
export type Step = { service: string; prefix: Prefix; text: string; action?: Action };

/**
 * One pass: report what is up, start what is down, skip what waits for
 * something not up yet. A service this pass starts does not count as up for
 * the ones after it: the next /dev-up starts them. Nothing waits.
 */
export function plan(stack: Stack, seen: Observed): Step[] {
  const steps: Step[] = [];
  const isUp = (name: string) => seen[name]?.state === "up";
  for (const s of stack.services) {
    const { state, why, needsInstall } = seen[s.name] ?? { state: "down" as const };
    const say = (prefix: Prefix, text: string, action?: Action) =>
      steps.push({ service: s.name, prefix, text: `${s.name}: ${text}`, ...(action ? { action } : {}) });

    if (s.kind === "check") {
      // The script is its own health check: it runs on every pass once what it waits for is up.
      const waiting = s.after.filter((d) => !isUp(d));
      if (waiting.length) say("SKIP", `waits for ${waiting.join(", ")}; next run`);
      else say("STARTED", s.check!, "check");
      continue;
    }
    if (s.kind === "compose") {
      if (state === "up") say("UP", why ?? "containers up");
      else if (state === "starting") say("SKIP", `${why ?? "not healthy yet"}; what waits for it starts next run`);
      else if (state === "broken") say("WARN", why ?? "a container needs a hand");
      else say("STARTED", "docker compose up -d", "compose");
      continue;
    }
    if (state === "up") {
      say("UP", s.kind === "server" ? (s.port ? `:${s.port}` : "running") : "done");
      continue;
    }
    if (state === "starting") {
      say("SKIP", s.kind === "server" && s.port ? `started, not answering on :${s.port} yet` : "still running; next run");
      continue;
    }
    if (state === "broken") say("WARN", why ?? "exited since it was started");
    if (needsInstall) {
      say("WARN", `${needsInstall}: install there first`);
      continue;
    }
    const waiting = s.after.filter((d) => !isUp(d));
    if (waiting.length) {
      say("SKIP", `waits for ${waiting.join(", ")}; next run`);
      continue;
    }
    say("STARTED", s.kind === "server" ? s.run! : s.task!, "start");
  }
  return steps;
}

/** Which checkout serves a service instead of its own: service name → folder, absolute. */
export type Overrides = Record<string, string>;

/** `path` moved from one checkout's top folder to another's, or undefined when it is outside the first. */
export function rebase(path: string, fromTop: string, toTop: string): string | undefined {
  if (path === fromTop) return toTop;
  return path.startsWith(`${fromTop}/`) ? toTop + path.slice(fromTop.length) : undefined;
}

/** The other checkout's folder name: `dir` with the trailing folders it shares with `own` taken off. */
function checkoutName(own: string, dir: string): string {
  const a = own.split("/").filter(Boolean);
  const b = dir.split("/").filter(Boolean);
  while (a.length > 1 && b.length > 1 && a.at(-1) === b.at(-1)) a.pop(), b.pop();
  return b.at(-1) ?? dir;
}

/** The stack with each overridden server or task run from its other checkout. */
export function applyOverrides(stack: Stack, overrides: Overrides): Stack {
  return {
    ...stack,
    services: stack.services.map((s) => {
      const dir = overrides[s.name];
      if (!dir || dir === s.dir || (s.kind !== "server" && s.kind !== "task")) return s;
      return {
        ...s,
        dir,
        servedFrom: checkoutName(s.dir, dir),
        ...(s.creates ? { creates: rebase(s.creates, s.dir, dir) ?? s.creates } : {}),
      };
    }),
  };
}

const GLYPH: Record<State, string> = { up: "●", starting: "◐", down: "○", broken: "✕" };

export function statusLine(stack: Stack, seen: Observed): string {
  const parts = stack.services.map((s) => {
    const state = seen[s.name]?.state ?? "down";
    const glyph = s.kind === "task" && state === "up" ? "✓" : GLYPH[state];
    return `${glyph} ${s.name}${s.servedFrom ? `@${s.servedFrom}` : ""}`;
  });
  return `${stack.name}  ${parts.join("  ")}`;
}

export const formatStep = (step: Pick<Step, "prefix" | "text">) => `${step.prefix.padEnd(8)}${step.text}`;

/** A check script's line, `PREFIX text`, or undefined for any other line. */
export function parseLine(line: string): { prefix: Prefix; text: string } | undefined {
  const m = /^(UP|STARTED|SKIP|WARN|STOP|ACTION)\s+(.*)$/.exec(line.trim());
  return m ? { prefix: m[1] as Prefix, text: m[2]! } : undefined;
}

/** A check's state from its lines: the worst one wins. */
export function stateOfLines(prefixes: Prefix[]): State {
  if (prefixes.some((p) => p === "WARN" || p === "STOP")) return "broken";
  if (prefixes.some((p) => p === "STARTED" || p === "SKIP" || p === "ACTION")) return "starting";
  return prefixes.length ? "up" : "down";
}

/** A compose project's state from `docker compose ps -a --format json`. */
export function composeState(s: Service, psJson: string): Seen {
  const rows: { Service?: string; State?: string; Health?: string; Status?: string }[] = [];
  const trimmed = psJson.trim();
  if (trimmed.startsWith("[")) rows.push(...JSON.parse(trimmed));
  else for (const line of trimmed.split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  if (rows.length === 0) return { state: "down", why: "no containers" };

  const stale = rows.find((r) => /Exited \(127\)/.test(r.Status ?? ""));
  if (stale)
    return {
      state: "broken",
      why: `${stale.Service} is Exited (127), a stale bind mount after Docker restarted: docker compose up -d --force-recreate ${stale.Service}`,
    };

  const byName = new Map(rows.map((r) => [r.Service ?? "", r]));
  const want = s.healthy.length || s.running.length ? [...s.healthy, ...s.running] : [...byName.keys()];
  const stopped = want.filter((n) => byName.get(n)?.State !== "running");
  if (stopped.length) return { state: "down", why: `${stopped.join(", ")} not running` };
  const unhealthy = s.healthy.filter((n) => byName.get(n)?.Health !== "healthy");
  if (unhealthy.length) {
    const sick = unhealthy.filter((n) => byName.get(n)?.Health === "unhealthy");
    if (sick.length) return { state: "broken", why: `${sick.join(", ")} unhealthy: check docker compose logs` };
    return { state: "starting", why: `${unhealthy.join(", ")} not healthy yet` };
  }
  const parts = [...s.healthy.map((n) => `${n} healthy`), ...s.running.map((n) => `${n} up`)];
  return { state: "up", why: parts.length ? parts.join(", ") : `${want.length} containers up` };
}
