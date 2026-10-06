import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import {
  bmpToPreview,
  fromBase64,
  ppmToPreview,
  toBase64,
} from "../hooks/preview";

/** A 2×3 P6 image: red, green / blue, white / black, grey. */
const PPM = new Uint8Array([
  ...new TextEncoder().encode("P6\n2 3\n255\n"),
  ...[255, 0, 0, 0, 255, 0],
  ...[0, 0, 255, 255, 255, 255],
  ...[0, 0, 0, 128, 128, 128],
]);

/** The same picture as ImageMagick's BMP3 (24-bit, bottom-up), grey at 127. */
const BMP24 =
  "Qk1OAAAAAAAAADYAAAAoAAAAAgAAAAMAAAABABgAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf39/AAD/AAD///8AAAAA/wD/AAAA";
/** And as a 32-bit BI_BITFIELDS BMP (V5 header), the kind sips writes. */
const BMP32 =
  "Qk2iAAAAAAAAAIoAAAB8AAAAAgAAAAMAAAABACAAAwAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAA/39/f///AAD//////wAA//8A/wD/";

const cellsOf = (cells = "") => [...new Uint32Array(fromBase64(cells).buffer)];

/** [glyph, fg = top pixel, bg = bottom pixel] per cell, row-major. */
const picture = (grey: number) => [
  0x2580,
  0xff0000,
  0x0000ff,
  0x2580,
  0x00ff00,
  0xffffff,
  0x2580,
  0x000000,
  0x01000000,
  0x2580,
  grey,
  0x01000000,
];

test("a PPM becomes half-block cells, two pixel rows per cell row", () => {
  const preview = ppmToPreview(PPM);
  expect(preview?.columns).toBe(2);
  expect(preview?.rows).toBe(2);
  expect(cellsOf(preview?.cells)).toEqual(picture(0x808080));
});

test("a 24-bit bottom-up BMP reads the same", () => {
  expect(cellsOf(bmpToPreview(fromBase64(BMP24))?.cells)).toEqual(
    picture(0x7f7f7f),
  );
});

test("a 32-bit bitfields BMP reads the same", () => {
  expect(cellsOf(bmpToPreview(fromBase64(BMP32))?.cells)).toEqual(
    picture(0x7f7f7f),
  );
});

test("anything else has no preview", () => {
  const gif = new TextEncoder().encode("GIF89a");
  expect(ppmToPreview(gif)).toBe(undefined);
  expect(bmpToPreview(gif)).toBe(undefined);
});

const PATH = "/home/me/shots/chart.png";
const PHOTO = "/home/me/shots/photo.jpg";
const WINDOWS_PATH = "\\\\wsl.localhost\\Ubuntu\\home\\me\\shots\\chart.png";

/** Claude sends an image; answers the mounted card and what ran on the host. */
async function sendImage(
  $: Engine,
  on: On,
  env: Record<string, string>,
  uname = "Linux",
  { path = PATH, converts = true } = {},
) {
  mock.env(on, { HOME: "/home/me", ...env });
  mock.clock(on);
  const ran: string[][] = [];
  const toasts: string[] = [];
  const answer = (exitCode: number, stdout: string) => ({
    value: {
      exitCode,
      stdout,
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  });
  on("process.run", (_$, e) => {
    ran.push([...e.argv]);
    // A PNG copy written into the mod's own folder.
    if (e.argv[0] === "sh" && e.argv[5]?.startsWith("/home/me/.claude/"))
      return answer(converts ? 0 : 1, "");
    if (e.argv[0] === "sh") return answer(0, `640 960\n${toBase64(PPM)}`);
    if (e.argv[0] === "wslpath") return answer(0, `${WINDOWS_PATH}\n`);
    if (e.argv[0] === "uname") return answer(0, `${uname}\n`);
    return answer(1, "");
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  // The engine's own drawing of the row, which the card goes under.
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  let callId = "";
  on("tool.call", { tool: "SendUserFile" }, (_$, e) => {
    callId = e.tool_use_id;
    return {
      result: { attachments: [{ path, size: 10, isImage: true }] },
    };
  });

  await $.tool.call({ tool: "SendUserFile", files: [path], status: "normal" });

  const ui = await $.ui.mount({
    plugin: "image-peek",
    surface: "terminal",
    component: "ToolUse",
    requestId: callId,
    props: {
      tool_use_id: callId,
      tool: "SendUserFile",
      input: { files: [path] },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  });
  return { ui, ran, toasts, callId };
}

test("on WSL, Reveal selects the image in Explorer and Open opens it", async ($, on) => {
  const { ui, ran, toasts } = await sendImage($, on, {
    WSL_DISTRO_NAME: "Ubuntu",
  });
  const preview = ran.find((argv) => argv[0] === "sh");
  expect(preview?.[4]).toBe(PATH);
  // The decoder is forced from the extension, never sniffed from the content.
  expect(preview?.[7]).toBe("png");
  expect(await ui.find({ key: "preview-1" })).toBeDefined();
  expect(
    await ui.find({ type: "Text", text: /#1 chart\.png · 640×960/ }),
  ).toBeDefined();

  await ui.press({ key: "reveal-1" });
  expect(ran.at(-1)).toEqual(["explorer.exe", `/select,${WINDOWS_PATH}`]);
  expect(toasts.join("|")).toMatch(/Revealed #1 in Explorer/);

  await ui.press({ key: "open-1" });
  expect(ran.at(-1)).toEqual(["explorer.exe", WINDOWS_PATH]);
});

test("on a Mac, Reveal shows it in Finder and Open uses open", async ($, on) => {
  const { ui, ran, toasts } = await sendImage($, on, {}, "Darwin");
  await ui.press({ key: "reveal-1" });
  expect(ran.at(-1)).toEqual(["open", "-R", PATH]);
  expect(toasts.join("|")).toMatch(/Revealed #1 in Finder/);
  await ui.press({ key: "open-1" });
  expect(ran.at(-1)).toEqual(["open", PATH]);
});

test("in Ghostty the image itself is drawn, sized to its shape", async ($, on) => {
  const { ui } = await sendImage($, on, { TERM_PROGRAM: "ghostty" });
  const image = await ui.find({ key: "image-1" });
  expect(image).toBeDefined();
  expect(image?.props).toMatchObject({
    source: { file: PATH, format: "png" },
    columns: 32,
    rows: 24,
  });
  expect(await ui.find({ key: "preview-1" })).toBe(undefined);
});

test("in Ghostty a JPEG is drawn from a PNG copy in the mod's folder", async ($, on) => {
  const { ui, ran, callId } = await sendImage(
    $,
    on,
    { TERM_PROGRAM: "ghostty" },
    "Linux",
    { path: PHOTO },
  );
  const png = `/home/me/.claude/image-peek/1970-01-01/${callId}-1.png`;
  const copy = ran.find((argv) => argv[0] === "sh" && argv[5] === png);
  // The decoder is forced from the extension here too.
  expect(copy?.slice(4)).toEqual([PHOTO, png, "jpeg"]);
  expect((await ui.find({ key: "image-1" }))?.props).toMatchObject({
    source: { file: png, format: "png" },
  });
  expect(await ui.find({ key: "preview-1" })).toBe(undefined);
  // Open and Reveal still act on the file Claude sent.
  await ui.press({ key: "open-1" });
  expect(ran.at(-1)).toEqual(["xdg-open", PHOTO]);
});

test("in Ghostty a JPEG whose PNG copy fails is drawn as blocks", async ($, on) => {
  const { ui } = await sendImage($, on, { TERM_PROGRAM: "ghostty" }, "Linux", {
    path: PHOTO,
    converts: false,
  });
  expect(await ui.find({ key: "image-1" })).toBe(undefined);
  expect(await ui.find({ key: "preview-1" })).toBeDefined();
});

test("outside a graphics terminal no PNG copy is written", async ($, on) => {
  const { ran } = await sendImage($, on, {}, "Linux", { path: PHOTO });
  expect(ran.filter((argv) => argv[0] === "sh")).toHaveLength(1);
});

test("in Ghostty behind a multiplexer the blocks are drawn", async ($, on) => {
  const { ui } = await sendImage($, on, {
    TERM_PROGRAM: "ghostty",
    TMUX: "/tmp/tmux-1/default",
  });
  expect(await ui.find({ key: "image-1" })).toBe(undefined);
  expect(await ui.find({ key: "preview-1" })).toBeDefined();
});

test(
  "preview: blocks wins over a terminal that draws images",
  { options: { preview: "blocks" } },
  async ($, on) => {
    const { ui } = await sendImage($, on, { TERM_PROGRAM: "ghostty" });
    expect(await ui.find({ key: "image-1" })).toBe(undefined);
    expect(await ui.find({ key: "preview-1" })).toBeDefined();
  },
);

test("a row with no image is drawn as the engine draws it", async ($, on) => {
  mock.env(on, { HOME: "/home/me" });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  const ui = await $.ui.mount({
    plugin: "image-peek",
    surface: "terminal",
    component: "ToolUse",
    requestId: "call-9",
    props: {
      tool_use_id: "call-9",
      tool: "SendUserFile",
      input: { files: [] },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  });
  expect(await ui.find({ key: "reveal-1" })).toBe(undefined);
});

test("a path that does not resolve to an absolute one gets no card and runs nothing", async ($, on) => {
  mock.env(on, { HOME: "/home/me" });
  const ran: string[][] = [];
  on("process.run", (_$, e) => {
    ran.push([...e.argv]);
    return { value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  let callId = "";
  const given = "|touch pwned.png";
  on("tool.call", { tool: "SendUserFile" }, (_$, e) => {
    callId = e.tool_use_id;
    return { result: { attachments: [{ path: given, size: 10, isImage: true }] } };
  });
  await $.tool.call({ tool: "SendUserFile", files: [given], status: "normal" });

  expect(ran).toEqual([["realpath", "--", given]]);
  const ui = await $.ui.mount({
    plugin: "image-peek",
    surface: "terminal",
    component: "ToolUse",
    requestId: callId,
    props: { tool_use_id: callId, tool: "SendUserFile", input: { files: [given] }, isRunning: false, isErrored: false, isInterrupted: false },
  });
  expect(await ui.find({ key: "reveal-1" })).toBe(undefined);
});
