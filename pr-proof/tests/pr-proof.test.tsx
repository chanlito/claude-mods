import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import { toBase64 } from "../hooks/preview";
import {
  countsOf,
  findRefs,
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
    { claim: "Offline upgrade keeps every row", where: "Tablet", result: "pass", evidence: ["counts.json", "run.command"] },
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
    { name: "shop-web", pr: 541 },
    { name: "api", pr: 12 },
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
function stage($: Engine, on: On, env: Record<string, string>, uname = "Linux") {
  mock.env(on, { HOME: "/home/me", ...env });
  mock.clock(on);
  const ran: string[][] = [];
  const toasts: string[] = [];
  const entry = (name: string) => ({ name, kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false });
  on("fs.list", (_$, e) => {
    if (e.path === ROOT) return { value: [entry("shop-web"), entry("a&calc")] };
    if (e.path === `${ROOT}/a&calc`) return { value: [entry("541")] };
    if (e.path === `${ROOT}/shop-web`) return { value: [entry("541")] };
    return { value: [] };
  });
  on("fs.read", (_$, e) => ({ value: e.path.endsWith("/541/proof.json") ? JSON.stringify(RECORD) : "" }));
  on("process.run", (_$, e) => {
    ran.push([...e.argv]);
    if (e.argv[0] === "sh")
      return answer(0, `1000 625\n${e.argv[8] === "image" ? PNG : toBase64(PPM)}`);
    if (e.argv[0] === "git") return answer(0, "/home/me/code/shop-web\n");
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
  expect(await ui.find({ type: "Text", text: /shop-web#541 · 3 checks · 2 changes · 1 failed · 1 not checked/ })).toBeDefined();
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
