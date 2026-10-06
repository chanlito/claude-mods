import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import { composeState, parseLine, parseStack, pickStack, plan, stateOfLines, statusLine, type Observed } from "../hooks/stack";
import { parseYaml } from "../hooks/yaml";

const HOME = "/home/me";
const STACKS = `${HOME}/.claude/dev-stacks`;
const ROOT = `${HOME}/code/shop`;

/** The made-up stack every test runs on: no real project belongs in this mod. */
const SHOP = `# a test stack
name: shop
root: ~/code/shop
notes: shop/NOTES.md

services:
  db:
    compose: .                     # docker-compose.yml at the root
    ready: { healthy: [postgres], up: [mail] }
  web:
    cwd: web
    run: pnpm dev
    port: 3000
    after: [db]
  codegen:
    cwd: web
    task: pnpm codegen
    creates: src/generated
    after: [web]
  worker:
    run: "pnpm worker # not a comment"
    after:
      - db
  seed:
    check: shop/seed.sh
    after: [web]

report:
  web: http://localhost:3000/health
`;

const stack = () => parseStack(SHOP, `${STACKS}/shop.yml`, HOME);
const seen = (states: Record<string, Observed[string]["state"]>): Observed =>
  Object.fromEntries(Object.entries(states).map(([k, state]) => [k, { state }]));

test("the YAML subset: maps, lists, flow lists and maps, quotes, comments", () => {
  expect(
    parseYaml(`a: 1
b: "x # y"
c: [p, 'q r', 3]
d: { k: v, l: [1, 2] }
e:
  - one
  - name: two
    deep: true
f: npm run start:dev   # trailing comment
g: http://localhost:8080/x
h:
`),
  ).toEqual({
    a: 1,
    b: "x # y",
    c: ["p", "q r", 3],
    d: { k: "v", l: [1, 2] },
    e: ["one", { name: "two", deep: true }],
    f: "npm run start:dev",
    g: "http://localhost:8080/x",
    h: null,
  });
  expect(() => parseYaml("a: 1\n  b: 2")).toThrow(/line 2/);
  expect(() => parseYaml("a: [1, 2")).toThrow(/line 1/);
  expect(() => parseYaml("a: 1\na: 2")).toThrow(/twice/);
});

test("a stack file: paths resolve, kinds are told apart, dependencies come first", () => {
  const s = stack();
  expect(s.name).toBe("shop");
  expect(s.root).toBe(ROOT);
  expect(s.notes).toBe(`${STACKS}/shop/NOTES.md`);
  expect(s.services.map((x) => `${x.name}:${x.kind}`)).toEqual([
    "db:compose",
    "web:server",
    "codegen:task",
    "worker:server",
    "seed:check",
  ]);
  const [db, web, codegen, worker, seed] = s.services;
  expect(db).toMatchObject({ dir: ROOT, healthy: ["postgres"], running: ["mail"] });
  expect(web).toMatchObject({ dir: `${ROOT}/web`, run: "pnpm dev", port: 3000, after: ["db"] });
  expect(codegen?.creates).toBe(`${ROOT}/web/src/generated`);
  expect(worker).toMatchObject({ dir: ROOT, run: "pnpm worker # not a comment", after: ["db"] });
  expect(seed?.check).toBe(`${STACKS}/shop/seed.sh`);
  expect(s.report).toEqual([{ name: "web", url: "http://localhost:3000/health" }]);
});

test("a stack file that cannot work says why", () => {
  const bad = (text: string) => () => parseStack(text, `${STACKS}/x.yml`, HOME);
  expect(bad("services: { a: { run: x } }")).toThrow(/root/);
  expect(bad("root: /x\nservices: { a: { run: x, after: [b] } }")).toThrow(/"b", which is not a service/);
  expect(bad("root: /x\nservices: { a: { run: x, task: y } }")).toThrow(/exactly one/);
  expect(bad("root: /x\nservices: { a: { run: x, after: [b] }, b: { run: y, after: [a] } }")).toThrow(/waits for itself/);
  expect(bad("root: /x\nservices: { a: { task: x } }")).toThrow(/creates/);
});

test("the deepest root that holds the folder wins", () => {
  const outer = parseStack("root: ~/code\nservices: { a: { run: x } }", `${STACKS}/outer.yml`, HOME);
  const shop = stack();
  expect(pickStack([outer, shop], `${ROOT}/web/src`)?.name).toBe("shop");
  expect(pickStack([outer, shop], `${HOME}/code/other`)?.name).toBe("outer");
  expect(pickStack([outer, shop], `${HOME}/code-old`)).toBe(undefined);
});

test("everything down: start the containers, skip what waits for them", () => {
  const steps = plan(stack(), {});
  expect(steps.map((s) => `${s.prefix} ${s.text}`)).toEqual([
    "STARTED db: docker compose up -d",
    "SKIP web: waits for db; next run",
    "SKIP codegen: waits for web; next run",
    "SKIP worker: waits for db; next run",
    "SKIP seed: waits for web; next run",
  ]);
  expect(steps[0]?.action).toBe("compose");
});

test("a service started this pass does not count as up until the next pass", () => {
  const steps = plan(stack(), seen({ db: "up" }));
  expect(steps.map((s) => `${s.prefix} ${s.service}`)).toEqual([
    "UP db",
    "STARTED web",
    "SKIP codegen",
    "STARTED worker",
    "SKIP seed",
  ]);
});

test("all up but a crashed server: warn, then start it again; missing node_modules: warn, never start", () => {
  const s = stack();
  const steps = plan(s, {
    ...seen({ db: "up", codegen: "up", seed: "up" }),
    web: { state: "broken", why: "exited since it was started" },
    worker: { state: "down", needsInstall: `no node_modules in ${ROOT}` },
  });
  expect(steps.map((x) => `${x.prefix} ${x.text}`)).toEqual([
    "UP db: containers up",
    "WARN web: exited since it was started",
    "STARTED web: pnpm dev",
    "UP codegen: done",
    `WARN worker: no node_modules in ${ROOT}: install there first`,
    "UP seed: up",
  ]);
});

test("the status line", () => {
  expect(statusLine(stack(), seen({ db: "up", web: "starting", worker: "broken" }))).toBe(
    "shop  ● db  ◐ web  ○ codegen  ✕ worker  ○ seed",
  );
});

test("docker compose ps: healthy, still starting, stale after a Docker restart, down", () => {
  const db = stack().services[0]!;
  const row = (Service: string, State: string, Health = "", Status = "Up 2 minutes") =>
    JSON.stringify({ Service, State, Health, Status });
  expect(composeState(db, [row("postgres", "running", "healthy"), row("mail", "running")].join("\n"))).toEqual({
    state: "up",
    why: "postgres healthy, mail up",
  });
  expect(composeState(db, `[${row("postgres", "running", "starting")},${row("mail", "running")}]`).state).toBe("starting");
  expect(composeState(db, [row("postgres", "exited", "", "Exited (127) 3 hours ago"), row("mail", "running")].join("\n"))).toMatchObject({
    state: "broken",
    why: expect.stringMatching(/--force-recreate postgres/),
  });
  expect(composeState(db, row("postgres", "running", "healthy")).state).toBe("down");
  expect(composeState(db, "").state).toBe("down");
});

test("a check script's lines", () => {
  expect(parseLine("UP      emulator booted")).toEqual({ prefix: "UP", text: "emulator booted" });
  expect(parseLine("api 200  metro 200")).toBe(undefined);
  expect(stateOfLines(["UP", "UP"])).toBe("up");
  expect(stateOfLines(["UP", "SKIP"])).toBe("starting");
  expect(stateOfLines(["UP", "WARN"])).toBe("broken");
});

/* ---- through the engine ---- */

const answer = (exitCode: number, stdout: string, stderr = "") => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

/** The shop stack on disk, the session in its web folder, Docker and the shell answered from memory. */
function stage(
  on: On,
  machine: { compose: string; ports?: number[]; pids?: string[]; files?: string[]; cwd?: string; mtimes?: Record<string, number> },
) {
  mock.env(on, { HOME });
  mock.clock(on);
  const ran: { argv: string[]; cwd?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const files = new Set([`${STACKS}/shop.yml`, ...(machine.files ?? [])]);
  on("session.cwd", () => ({ value: machine.cwd ?? `${ROOT}/web` }));
  on("fs.list", (_$, e) =>
    ({ value: e.path === STACKS ? [{ name: "shop.yml", kind: "file" as const, size: 1, mtimeMs: 0, isLink: false }] : [] }),
  );
  on("fs.read", (_$, e) => ({ value: e.path === `${STACKS}/shop.yml` ? SHOP : "" }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.stat", (_$, e) => {
    const mtimeMs = machine.mtimes?.[e.path];
    if (mtimeMs === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: { kind: "file" as const, size: 1, mtimeMs, isLink: false } };
  });
  on("process.run", (_$, e) => {
    ran.push({ argv: [...e.argv], cwd: e.init?.cwd });
    const [cmd, a, b] = e.argv;
    if (cmd === "docker" && a === "compose" && b === "ps") return answer(0, machine.compose);
    if (cmd === "sh" && e.argv[2]?.includes("PORT"))
      return answer(0, [...(machine.ports ?? []).map((p) => `PORT ${p}`), ...(machine.pids ?? [])].join("\n"));
    if (cmd === "curl") return answer(0, "200");
    if (cmd === `${STACKS}/shop/seed.sh`) return answer(0, "UP      seeded\nrows 12\n");
    return answer(0, "");
  });
  on("ui.status", (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  return { ran, statuses };
}

const HEALTHY = [
  JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", Status: "Up" }),
  JSON.stringify({ Service: "mail", State: "running", Health: "", Status: "Up" }),
].join("\n");

const devUp = ($: Engine, args = "") =>
  $.command.run({ command: "dev-up", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } });

test("/dev-up with Docker down starts the containers in the root and nothing else", async ($, on) => {
  const { ran } = stage(on, { compose: "" });
  const out = await devUp($);
  expect(out.text).toMatch(/^STARTED db: docker compose up -d/m);
  expect(out.text).toMatch(/^SKIP {4}web: waits for db; next run/m);
  expect(ran.find((r) => r.argv.join(" ") === "docker compose up -d")?.cwd).toBe(ROOT);
  expect(ran.some((r) => r.argv[2]?.includes("setsid"))).toBe(false);
});

test("/dev-up with the containers healthy starts the servers detached, with a log and a pid file", async ($, on) => {
  const { ran, statuses } = stage(on, { compose: HEALTHY, files: [`${ROOT}/web/node_modules`] });
  const out = await devUp($);
  const starts = ran.filter((r) => r.argv[2]?.includes("setsid"));
  expect(starts.map((r) => r.argv.slice(4))).toEqual([
    [`${ROOT}/web`, "pnpm dev", `${HOME}/.cache/dev-up/shop/web.log`, `${HOME}/.cache/dev-up/shop/web.pid`],
    [ROOT, "pnpm worker # not a comment", `${HOME}/.cache/dev-up/shop/worker.log`, `${HOME}/.cache/dev-up/shop/worker.pid`],
  ]);
  expect(out.text).toMatch(/^UP {6}db: postgres healthy, mail up/m);
  expect(out.text).toMatch(/^STARTED web: pnpm dev {2}\(log .*web\.log\)/m);
  expect(out.text).toMatch(/^report {2}web 200/m);
  expect(statuses.at(-1)).toBe("shop  ● db  ◐ web  ○ codegen  ◐ worker  ○ seed");
});

test("with the server answering, the next pass runs the task and the check script and relays its lines", async ($, on) => {
  const { ran } = stage(on, {
    compose: HEALTHY,
    ports: [3000],
    pids: ["PID web alive", "PID worker alive"],
    files: [`${ROOT}/web/node_modules`],
  });
  const out = await devUp($);
  expect(out.text).toMatch(/^UP {6}web: :3000/m);
  expect(out.text).toMatch(/^STARTED codegen: pnpm codegen/m);
  expect(out.text).toMatch(/^UP {6}worker: running/m);
  expect(out.text).toMatch(/^UP {6}seed: seeded\n {8}rows 12/m);
  expect(ran.find((r) => r.argv[0] === `${STACKS}/shop/seed.sh`)?.cwd).toBe(ROOT);
});

test("--dry-run says what it would do and starts nothing", async ($, on) => {
  const { ran } = stage(on, { compose: HEALTHY, files: [`${ROOT}/web/node_modules`] });
  const out = await devUp($, "--dry-run");
  expect(out.text).toMatch(/^ACTION {2}web: pnpm dev {2}\(in .*\/web\)/m);
  expect(ran.some((r) => r.argv[2]?.includes("setsid"))).toBe(false);
});

test("a folder no stack covers gets told where stacks live", async ($, on) => {
  stage(on, { compose: "", cwd: "/tmp/elsewhere" });
  const out = await devUp($);
  expect(out.text).toMatch(/No stack covers \/tmp\/elsewhere\. A stack is \/home\/me\/\.claude\/dev-stacks\/<name>\.yml/);
});

test("the model's tool answers the same as the command", async ($, on) => {
  stage(on, { compose: HEALTHY, ports: [3000], pids: ["PID web alive"] });
  const out = await $.tool.call({ tool: "mcp__dev-up__dev_up", action: "status" });
  expect(String(out.result)).toMatch(/^up {7}db {2}postgres healthy, mail up\nup {7}web/m);
});

test("restart adds its extra arguments to the command, this once", async ($, on) => {
  const { ran } = stage(on, { compose: HEALTHY, ports: [3000], pids: ["PID web alive"], files: [`${ROOT}/web/node_modules`] });
  const out = await devUp($, "restart web -- --clear");
  const stops = ran.filter((r) => r.argv[2]?.includes("holders()"));
  const starts = ran.filter((r) => r.argv[2]?.includes("setsid"));
  expect(stops.map((r) => r.argv.slice(4, 6))).toEqual([[`${HOME}/.cache/dev-up/shop/web.pid`, "3000"]]);
  expect(starts.map((r) => r.argv[5])).toEqual(["pnpm dev '--' '--clear'"]);
  expect(out.text).toMatch(/^Restarted web with -- --clear {2}\(log /);
});

test("the tool passes restart's args through; containers take none", async ($, on) => {
  const { ran } = stage(on, { compose: HEALTHY, ports: [3000], pids: ["PID web alive"], files: [`${ROOT}/web/node_modules`] });
  await $.tool.call({ tool: "mcp__dev-up__dev_up", action: "restart", service: "web", args: "-- --clear" });
  expect(ran.filter((r) => r.argv[2]?.includes("setsid")).map((r) => r.argv[5])).toEqual(["pnpm dev '--' '--clear'"]);
  const out = await devUp($, "restart db -- --pull");
  expect(out.text).toMatch(/db is containers; restart takes no extra arguments/);
});

test("restart's extra words reach the shell as text, never as commands", async ($, on) => {
  const { ran } = stage(on, { compose: HEALTHY, ports: [3000], pids: ["PID web alive"], files: [`${ROOT}/web/node_modules`] });
  await $.tool.call({ tool: "mcp__dev-up__dev_up", action: "restart", service: "web", args: "; touch /tmp/x $(id) it's" });
  expect(ran.filter((r) => r.argv[2]?.includes("setsid")).map((r) => r.argv[5])).toEqual([
    "pnpm dev ';' 'touch' '/tmp/x' '$(id)' 'it'\\''s'",
  ]);
});

test("a stack's name must be a plain folder name", () => {
  expect(() => parseStack("name: ../x\nroot: /x\nservices: { a: { run: x } }", `${STACKS}/x.yml`, HOME)).toThrow(/names a folder/);
});

test("a lockfile newer than the last install: warn and do not start", async ($, on) => {
  const { ran } = stage(on, {
    compose: HEALTHY,
    files: [`${ROOT}/web/package.json`, `${ROOT}/web/node_modules`],
    mtimes: { [`${ROOT}/web/package-lock.json`]: 2000, [`${ROOT}/web/node_modules/.package-lock.json`]: 1000 },
  });
  const out = await devUp($);
  expect(out.text).toMatch(/^WARN {4}web: package-lock\.json in .*\/web changed since the last npm install: install there first/m);
  expect(ran.filter((r) => r.argv[2]?.includes("setsid")).map((r) => r.argv[4])).toEqual([ROOT]);
});
