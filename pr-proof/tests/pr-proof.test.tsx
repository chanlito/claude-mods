import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import { toBase64 } from "../hooks/preview";
import {
  countsOf,
  findRecordPaths,
  findRefs,
  findUrlRefs,
  parseRecord,
  resolveRefs,
  safeName,
} from "../hooks/record";

const ROOT = "/home/me/pr-proof";
const DIR = `${ROOT}/shop-web/541`;

const RECORD = {
  repo: "acme/shop-web",
  pr: 541,
  title: "Encrypt the local database",
  url: "https://github.com/acme/shop-web/pull/541",
  aliases: ["web"],
  changes: [
    { title: "Warning on Home", before: "warning-before.png", after: "warning-after.png" },
    { title: "Settings line", after: "settings-after.png" },
  ],
  checks: [
    { claim: "Offline upgrade keeps every row", where: "Tablet", result: "pass", evidence: ["counts.json", "run.command", "linked.png", "fake.png", "shot.png", "escape.png", "jpeg-named.png"] },
    { claim: "Killed upgrade recovers", where: "Tablet", result: "fail" },
    { claim: "Every crash state", where: "Unit tests", result: "pass" },
  ],
  notChecked: ["The signed release build"],
};

const record = () => parseRecord(JSON.stringify(RECORD), DIR, "shop-web", 541)!;

test("a reply's PR refs: names, owner/name, URLs and bare numbers, each once", () => {
  expect(
    findRefs(
      "web#541 is ready (https://github.com/acme/shop-web/pull/541), see acme/api#12, also #7 and web#541 again; not a#b or x/#9",
    ),
  ).toEqual([
    { name: "web", pr: 541 },
    { owner: "acme", name: "shop-web", pr: 541 },
    { owner: "acme", name: "api", pr: 12 },
    { pr: 7 },
  ]);
});

test("a name, the repo's name or an alias finds the record; an unknown name does not", () => {
  const r = record();
  expect(resolveRefs([{ name: "web", pr: 541 }], [r])).toEqual([r]);
  expect(resolveRefs([{ name: "shop-web", pr: 541 }], [r])).toEqual([r]);
  expect(resolveRefs([{ name: "api", pr: 541 }], [r])).toEqual([]);
  expect(resolveRefs([{ name: "web", pr: 542 }], [r])).toEqual([]);
});

test("a bare #541 needs one record with that number, or the session's repo", () => {
  const r = record();
  const other = parseRecord(JSON.stringify(RECORD), `${ROOT}/api/541`, "api", 541)!;
  expect(resolveRefs([{ pr: 541 }], [r])).toEqual([r]);
  expect(resolveRefs([{ pr: 541 }], [r, other])).toEqual([]);
  expect(resolveRefs([{ pr: 541 }], [r, other], "api")).toEqual([other]);
});

test("a file name that leaves the record's folder is dropped", () => {
  expect(safeName("shots/after.png")).toBe("shots/after.png");
  expect(safeName("../secret.png")).toBe(undefined);
  expect(safeName("/etc/passwd")).toBe(undefined);
  expect(safeName("a;rm -rf.png")).toBe(undefined);
  const r = parseRecord(
    JSON.stringify({ changes: [{ title: "x", after: "../../x.png" }], checks: [{ claim: "c", evidence: ["$(id).png"] }] }),
    DIR,
    "shop-web",
    541,
  )!;
  expect(r.changes).toEqual([]);
  expect(r.checks[0]?.evidence).toEqual([]);
});

test("the counts say what failed and what was not checked", () => {
  expect(countsOf(record())).toBe("3 checks · 2 changes · 1 failed · 1 not checked");
  expect(parseRecord("not json", DIR, "shop-web", 541)).toBe(undefined);
});

/** A 2×2 P6 image, for the half-block preview. */
const PPM = new Uint8Array([
  ...new TextEncoder().encode("P6\n2 2\n255\n"),
  ...[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
]);

/** A 1×1 PNG, for the sharp picture. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const answer = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

/** Records on disk, the host's processes and toasts, all answered from memory. */
function stage($: Engine, on: On, env: Record<string, string>, uname = "Linux", merged = new Set<string>()) {
  mock.env(on, { HOME: "/home/me", ...env });
  mock.clock(on);
  const ran: string[][] = [];
  const toasts: string[] = [];
  const entry = (name: string) => ({ name, kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false });
  on("fs.list", (_$, e) => {
    if (e.path === ROOT) return { value: [entry("shop-web"), entry("a&calc"), entry("api")] };
    if (e.path === `${ROOT}/api`) return { value: [entry("12")] };
    if (e.path === `${ROOT}/a&calc`) return { value: [entry("541")] };
    if (e.path === `${ROOT}/shop-web`) return { value: [entry("541")] };
    return { value: [] };
  });
  on("fs.read", (_$, e) => {
    if (e.as === "bytes")
      return {
        value: {
          base64: e.path.endsWith("fake.png")
            ? toBase64(new TextEncoder().encode("#!/bin/sh\nid\n"))
            : e.path.endsWith("jpeg-named.png")
              ? toBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))
              : PNG,
        },
      };
    if (e.path === `${ROOT}/api/12/proof.json`)
      return { value: JSON.stringify({ repo: "acme/api", title: "Rate limits", checks: [{ claim: "c", result: "pass" }] }) };
    return { value: e.path.endsWith("/541/proof.json") ? JSON.stringify(RECORD) : "" };
  });
  on("fs.stat", (_$, e) => ({
    value: {
      kind: e.path === DIR ? ("dir" as const) : ("file" as const),
      size: 10,
      mtimeMs: 0,
      isLink: e.path.endsWith("linked.png"),
      // A linked folder above escape.png leads out of the record's folder.
      realPath: e.path.endsWith("escape.png") ? "/etc/elsewhere/escape.png" : e.path,
    },
  }));
  on("process.run", (_$, e) => {
    ran.push([...e.argv]);
    if (e.argv[0] === "sh")
      return answer(0, `1000 625\n${e.argv[8] === "image" ? PNG : toBase64(PPM)}`);
    if (e.argv[0] === "git") return answer(0, "/home/me/code/shop-web\n");
    if (e.argv[0] === "gh" && e.argv[1] === "api") {
      const path = e.argv[2] ?? "";
      if (merged.has(path)) return answer(0, "closed\n");
      // Only the PRs a test names exist; any other path is no PR at all.
      return /pulls\/(541|12|77|99)$/.test(path) ? answer(0, "open\n") : answer(1, "");
    }
    if (e.argv[0] === "wslpath") return answer(0, `\\\\wsl.localhost\\Ubuntu${e.argv[2]?.replaceAll("/", "\\")}\n`);
    if (e.argv[0] === "uname") return answer(0, `${uname}\n`);
    return answer(0, "");
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  return { ran, toasts };
}

const reply = ($: Engine, text: string, surface: "terminal" | "desktop" = "terminal") =>
  $.ui.mount({
    plugin: "pr-proof",
    surface,
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text, isFirstOfReply: true },
  });

test("a reply naming a PR with a record gets the button, closed", async ($, on) => {
  stage($, on, {});
  const ui = await reply($, "web#541 is ready for review.");
  expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  // The row sits under the PR's name: it names it again only beside another PR's button.
  expect(await ui.find({ type: "Text", text: /shop-web#541|3 checks/ })).toBe(undefined);
  expect(await ui.find({ key: "pp-shop-web-541-details" })).toBe(undefined);
});

test("a reply naming no recorded PR is left alone", async ($, on) => {
  stage($, on, {});
  const ui = await reply($, "api#12 is ready.");
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`on ${surface}, the button opens the checks, the changes and what was not checked`, async ($, on) => {
    stage($, on, {});
    const ui = await reply($, "web#541 is ready.", surface);
    await ui.press({ key: "pp-shop-web-541-toggle" });
    expect(await ui.find({ key: "pp-shop-web-541-details" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Warning on Home" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "(no before shot)" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Killed upgrade recovers" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "The signed release build" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /✗ 1 failed/ })).toBeDefined();
  });
}

test("outside kitty and Ghostty the pictures are half-block previews", async ($, on) => {
  const { ran } = stage($, on, { HERDR_ENV: "1" });
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  expect(await ui.find({ key: "raster-pp-shop-web-541-c0-after" })).toBeDefined();
  const made = ran.find((argv) => argv[0] === "sh");
  expect(made?.[4]).toBe(`${DIR}/warning-before.png`);
  // The decoder is forced from the extension, never sniffed from the content.
  expect(made?.[7]).toBe("png");
  expect(made?.[8]).toBe("blocks");
});

test("in kitty the pictures are drawn sharp", async ($, on) => {
  const { ran } = stage($, on, { KITTY_WINDOW_ID: "1" });
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  expect(await ui.find({ key: "img-pp-shop-web-541-c0-after" })).toBeDefined();
  expect(ran.find((argv) => argv[0] === "sh")?.[8]).toBe("image");
});

test("on WSL, Reveal selects the after shot in Explorer", async ($, on) => {
  const { ran, toasts } = stage($, on, { WSL_DISTRO_NAME: "Ubuntu" });
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  await ui.press({ key: "reveal-pp-shop-web-541-c0-after" });
  expect(ran.at(-1)?.[0]).toBe("explorer.exe");
  expect(ran.at(-1)?.[1]).toMatch(/^\/select,.*warning-after\.png$/);
  expect(toasts.join("|")).toMatch(/Revealed warning-after\.png in Explorer/);
});

test("on macOS, Reveal folder shows the record in Finder", async ($, on) => {
  const { ran, toasts } = stage($, on, {}, "Darwin");
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  await ui.press({ key: "pp-shop-web-541-folder" });
  expect(ran.at(-1)).toEqual(["open", "-R", `${DIR}/proof.json`]);
  expect(toasts.join("|")).toMatch(/in Finder/);
});

test("/proof lists the records", async ($, on) => {
  stage($, on, {});
  const out = await $.command.run({
    command: "proof",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  expect(out.text).toMatch(/shop-web#541 {2}3 checks · 2 changes · 1 failed · 1 not checked {2}Encrypt the local database/);
});

test("the system prompt names the records folder from the setting", { options: { root: "~/proofs/" } }, async ($, on) => {
  mock.env(on, { HOME: "/home/me" });
  on("prompt.compose", () => ({ sections: [{ id: "intro", text: "engine", scope: "shared" as const }] }));
  const { sections } = await $.prompt.compose({
    model: "m",
    promptModel: "m",
    surfaces: ["terminal"],
    tools: [],
    outputStyle: null,
    traits: [],
  });
  expect(sections.at(-1)?.id).toBe("pr-proof:root");
  expect(sections.at(-1)?.text).toMatch(/go in \/home\/me\/proofs\/<repo>\/<pr>\//);
});

test("Open reveals a file that would run instead of opening it", async ($, on) => {
  const { ran } = stage($, on, {}, "Darwin");
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  await ui.press({ key: "pp-shop-web-541-k0-e0" });
  expect(ran.at(-1)).toEqual(["open", `${DIR}/counts.json`]);
  await ui.press({ key: "pp-shop-web-541-k0-e1" });
  expect(ran.at(-1)).toEqual(["open", "-R", `${DIR}/run.command`]);
});

test("a records folder whose name is not a plain name is skipped", async ($, on) => {
  stage($, on, {});
  const out = await $.command.run({
    command: "proof",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  expect(out.text).toMatch(/shop-web#541/);
  expect(out.text).not.toMatch(/calc/);
});

test("Open reveals a link, and on Linux a file whose bytes are not what its name says", async ($, on) => {
  const { ran } = stage($, on, {});
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  await ui.press({ key: "pp-shop-web-541-k0-e2" });
  expect(ran.at(-1)?.[0]).not.toBe("xdg-open");
  await ui.press({ key: "pp-shop-web-541-k0-e3" });
  expect(ran.at(-1)?.[0]).not.toBe("xdg-open");
  await ui.press({ key: "pp-shop-web-541-k0-e4" });
  expect(ran.at(-1)).toEqual(["xdg-open", `${DIR}/shot.png`]);
});

test("Open reveals a file that resolves outside the record, or whose bytes are another format", async ($, on) => {
  const { ran } = stage($, on, {});
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  await ui.press({ key: "pp-shop-web-541-k0-e5" });
  expect(ran.some((argv) => argv[0] === "xdg-open" && argv[1]?.includes("elsewhere"))).toBe(false);
  expect(ran.at(-1)?.[0]).not.toBe("xdg-open");
  await ui.press({ key: "pp-shop-web-541-k0-e6" });
  expect(ran.at(-1)?.[0]).not.toBe("xdg-open");
});

const PR_URL = "https://github.com/acme/shop-web/pull/541";

test("a command's PR URLs and a call's record paths are refs", () => {
  expect(findUrlRefs(`Creating pull request\n${PR_URL}\n`)).toEqual([{ owner: "acme", name: "shop-web", pr: 541 }]);
  // Only URLs: "#7" in a command's chatter is not a PR it made.
  expect(findUrlRefs("closes #7, see web#541")).toEqual([]);
  expect(
    findRecordPaths(`mkdir -p ~/pr-proof/shop-web/541 && cp a ${ROOT}/api/12/x.png; ${ROOT}/api/12b`, ROOT, "/home/me"),
  ).toEqual([
    { name: "shop-web", pr: 541 },
    { name: "api", pr: 12 },
  ]);
});

const created = (tool_use_id: string) => ({
  tool_use_id,
  tool: "Bash",
  input: { command: "gh pr create --fill" },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: `${PR_URL}\n`, stderr: "" },
});

test("Claude Code's \"Created PR\" row gets the button, from the URL the command printed", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "ToolUse",
    requestId: "tu-1",
    props: created("tu-1"),
  });
  expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  await ui.press({ key: "pp-shop-web-541-toggle" });
  expect(await ui.find({ key: "pp-shop-web-541-details" })).toBeDefined();
});

test("a folded group of calls gets the button for the PR one of them created", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "ToolGroup",
    requestId: "tg-1",
    props: {
      calls: [
        { tool: "Read", input: { file_path: "/x" }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: "https://github.com/acme/api/pull/12" } },
        created("tu-2"),
      ],
      isActive: false,
      isExpanded: false,
    },
  });
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  // A Read's output is file text, not a command's: its URL is no PR made here.
  expect(await ui.find({ key: "pp-api-12-toggle" })).toBe(undefined);
});

test("a shell row that printed no PR is left alone", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "ToolUse",
    requestId: "tu-3",
    props: { ...created("tu-3"), output: { stdout: "ok\n", stderr: "" } },
  });
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
});

const listProof = ($: Engine) =>
  $.command.run({
    command: "proof",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });

test("/proof lists this session's PRs first: one it created, one whose record it wrote", async ($, on) => {
  stage($, on, {});
  on("tool.call", (_$, e) =>
    e.tool === "Bash" && /gh pr create/.test(String((e as { command?: unknown }).command))
      ? { result: { stdout: `${PR_URL}\n`, stderr: "" } }
      : { result: { stdout: "", stderr: "" } },
  );
  expect((await listProof($)).text).toMatch(/^None from this session yet\.\n\nOther sessions:\n/);

  await $.tool.call({ tool: "Bash", command: "gh pr create --fill" });
  let text = (await listProof($)).text ?? "";
  expect(text).toMatch(/^This session:\nshop-web#541 .*\n\nOther sessions:\napi#12 /);

  await $.tool.call({ tool: "Bash", command: `cat > ~/pr-proof/api/12/proof.json <<'EOF'` });
  text = (await listProof($)).text ?? "";
  expect(text).toMatch(/^This session:\nshop-web#541 .*\napi#12 [^\n]*$/);
  expect(text).not.toMatch(/Other sessions/);
});

test("a gh pr edit row gets the button too, from the URL it printed", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "ToolUse",
    requestId: "tu-edit",
    props: { ...created("tu-edit"), input: { command: "gh pr edit 541 --body-file b.md" } },
  });
  expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
});

test("a shell row that is not a gh pr call gets no button, whatever URL it printed", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "ToolUse",
    requestId: "tu-cat",
    props: { ...created("tu-cat"), input: { command: "cat notes.md" } },
  });
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
});

test("only the newest mention of a PR draws its button", async ($, on) => {
  stage($, on, {});
  const mount = (requestId: string, text: string) =>
    $.ui.mount({
      plugin: "pr-proof",
      surface: "terminal",
      component: "AssistantMessage",
      requestId,
      props: { text, isFirstOfReply: true },
    });
  const first = await mount("m-1", "web#541 is ready for review.");
  expect(await first.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  const second = await mount("m-2", "The list in web#541 now reads សំណង់.");
  expect(await second.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  expect(await first.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
  // The older reply redrawn does not take the button back.
  expect(await first.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
  expect(await second.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
});

for (const [columns, width] of [[undefined, 44], [100, 46], [200, 80]] as const) {
  test(`${columns ? `a ${columns}` : "an unmeasured"}-column transcript draws pictures ${width} cells wide`, async ($, on) => {
    const { ran } = stage($, on, { KITTY_WINDOW_ID: "1" });
    const ui = await $.ui.mount({
      plugin: "pr-proof",
      surface: "terminal",
      component: "AssistantMessage",
      requestId: `wide-${columns ?? 0}`,
      props: { text: "web#541 is ready.", isFirstOfReply: true },
      ...(columns ? { viewport: { columns, rows: 50 } } : {}),
    });
    await ui.press({ key: "pp-shop-web-541-toggle" });
    const made = ran.find((argv) => argv[0] === "sh");
    expect(made?.[5]).toBe(String(width));
    expect(await ui.find({ key: "img-pp-shop-web-541-c0-after" })).toBeDefined();
  });
}

test("a second Hide at the foot of an open proof closes it", async ($, on) => {
  stage($, on, {});
  const ui = await reply($, "web#541 is ready.");
  await ui.press({ key: "pp-shop-web-541-toggle" });
  expect(await ui.find({ key: "pp-shop-web-541-details" })).toBeDefined();
  await ui.press({ key: "pp-shop-web-541-hide" });
  expect(await ui.find({ key: "pp-shop-web-541-details" })).toBe(undefined);
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
});

test("a reply naming two recorded PRs labels each button", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "AssistantMessage",
    requestId: "two-prs",
    props: { text: "web#541 and api#12 are ready.", isFirstOfReply: true },
  });
  expect(await ui.find({ type: "Text", text: "shop-web#541" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "api#12" })).toBeDefined();
});

test("a PR opened with no record tells the model so, once, in the call's context", async ($, on) => {
  stage($, on, {});
  on("tool.call", () => ({ result: { stdout: "https://github.com/acme/api/pull/77\n", stderr: "" } }));
  const ran = await $.tool.call({ tool: "Bash", command: "gh pr create --fill" });
  expect(ran.context?.join("\n")).toMatch(/no proof record for api#77 yet/);
});

test("a PR opened with its record already written adds nothing", async ($, on) => {
  stage($, on, {});
  on("tool.call", () => ({ result: { stdout: `${PR_URL}\n`, stderr: "" } }));
  const ran = await $.tool.call({ tool: "Bash", command: "gh pr create --fill" });
  expect(ran.context ?? []).toEqual([]);
});

test("a merged PR's proof draws no button: there is nothing left to review", async ($, on) => {
  stage($, on, {}, "Linux", new Set(["repos/acme/shop-web/pulls/541"]));
  const ui = await reply($, "web#541 is merged.");
  expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBe(undefined);
});

test("an open PR, asked of gh, keeps its button", async ($, on) => {
  const { ran } = stage($, on, {});
  const ui = await reply($, "web#541 is ready.");
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  expect(ran.some((argv) => argv[0] === "gh" && argv[2] === "repos/acme/shop-web/pulls/541")).toBe(true);
});

test("two recorded PRs from two repos each draw a labelled button", async ($, on) => {
  stage($, on, {});
  const ui = await $.ui.mount({
    plugin: "pr-proof",
    surface: "terminal",
    component: "AssistantMessage",
    requestId: "two-repos",
    props: { text: "web#541 and acme/api#12 are both ready.", isFirstOfReply: true },
  });
  expect(await ui.find({ key: "pp-shop-web-541-toggle" })).toBeDefined();
  expect(await ui.find({ key: "pp-api-12-toggle" })).toBeDefined();
});

test("an open PR named with no record draws nothing", async ($, on) => {
  stage($, on, {});
  const ui = await reply($, "api#99 is ready for review.");
  expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
  expect(await ui.find({ type: "Button" })).toBe(undefined);
});
