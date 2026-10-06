import { atom, read, update } from "claude-code";
import type { CommandRunInput, EngineInterface, Register, RenderInput } from "claude-code";

import type { PeekImage, PeekPreview } from "../types";
import { decodePreview, extensionFor, fromBase64, isImagePath } from "./preview";

/** The thumbnail's box in pixels; a cell shows one pixel across, two down. */
const PREVIEW_WIDTH = 56;
const PREVIEW_HEIGHT = 36;
/** The largest box a sharp image (kitty graphics) is drawn in, in cells. */
const IMAGE_COLUMNS = 80;
const IMAGE_ROWS = 24;
/** How many images the session remembers (cards and commands). */
const KEEP = 60;

const images = atom({ plugin: "image-peek", key: "images" } as const, []);
const seq = atom({ plugin: "image-peek", key: "seq" } as const, 0);

/** Windows' own convert.exe (FAT to NTFS) is on a WSL PATH: not ImageMagick. */
const HAS = `has() { p=$(command -v "$1" 2>/dev/null) && case "$p" in /mnt/*) false ;; esac; }`;

/**
 * Prints `<w> <h>` (or `<w>x<h>`) on one line, then the thumbnail as base64
 * on the next: a PPM from ImageMagick or ffmpeg, a BMP from macOS's sips.
 * Exits non-zero when none of them is installed; the card then has no preview.
 *
 * "$1" is always an absolute path and "$4" the format its extension names,
 * forced on ImageMagick ("png:/path") so no prefix (\`|cmd\`, \`msl:\`,
 * \`ephemeral:\`) or content-sniffed coder (SVG, MVG, MSL in a .png) runs, and
 * ffmpeg reads only the local file.
 */
const PREVIEW_SCRIPT = `
f="$1"; w="$2"; h="$3"; t="$4"
case "$f" in /*) ;; *) exit 2 ;; esac
${HAS}
if has magick; then
  magick identify -format "%w %h\\n" "$t:$f[0]" 2>/dev/null | head -n 1
  magick "$t:$f[0]" -auto-orient -thumbnail "\${w}x\${h}" -background "#000000" -alpha remove -alpha off -depth 8 ppm:- | base64 | tr -d '\\n'
elif has convert && has identify; then
  identify -format "%w %h\\n" "$t:$f[0]" 2>/dev/null | head -n 1
  convert "$t:$f[0]" -auto-orient -thumbnail "\${w}x\${h}" -background "#000000" -alpha remove -alpha off -depth 8 ppm:- | base64 | tr -d '\\n'
elif has ffmpeg; then
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x -protocol_whitelist file "file:$f" 2>/dev/null | head -n 1
  ffmpeg -v error -protocol_whitelist file -i "file:$f" -frames:v 1 -vf "scale=w=$w:h=$h:force_original_aspect_ratio=decrease" -pix_fmt rgb24 -f image2pipe -vcodec ppm - | base64 | tr -d '\\n'
elif has sips; then
  ow=$(sips -g pixelWidth "$f" 2>/dev/null | awk '/pixelWidth/ { print $2 }')
  oh=$(sips -g pixelHeight "$f" 2>/dev/null | awk '/pixelHeight/ { print $2 }')
  [ -n "$ow" ] && [ -n "$oh" ] || exit 3
  echo "$ow $oh"
  tw=$w; th=$((oh * w / ow))
  if [ "$th" -gt "$h" ]; then th=$h; tw=$((ow * h / oh)); fi
  [ "$tw" -ge 1 ] || tw=1; [ "$th" -ge 1 ] || th=1
  tmp=$(mktemp "\${TMPDIR:-/tmp}/image-peek.XXXXXX") || exit 3
  sips -s format bmp -z "$th" "$tw" "$f" --out "$tmp.bmp" >/dev/null 2>&1 && base64 < "$tmp.bmp" | tr -d '\\n'
  ok=$?; rm -f "$tmp" "$tmp.bmp"; exit $ok
else
  exit 3
fi
`;

/**
 * Writes "$2", a PNG of "$1"'s first frame, for the terminal to draw: it reads
 * the file itself, and only a PNG. The decoder is forced from "$3" as in
 * PREVIEW_SCRIPT, and the PNG lands whole or not at all.
 */
const PNG_SCRIPT = `
f="$1"; o="$2"; t="$3"; part="$2.part.png"
case "$f" in /*) ;; *) exit 2 ;; esac
mkdir -p "$(dirname "$o")" || exit 1
${HAS}
if has magick; then
  magick "$t:$f[0]" -auto-orient "png:$part"
elif has convert; then
  convert "$t:$f[0]" -auto-orient "png:$part"
elif has ffmpeg; then
  ffmpeg -v error -protocol_whitelist file -i "file:$f" -frames:v 1 -f image2pipe -vcodec png - > "$part"
elif has sips; then
  sips -s format png "$f" --out "$part" >/dev/null 2>&1
else
  false
fi && [ -s "$part" ] && mv -f "$part" "$o"
ok=$?; rm -f "$part"; exit $ok
`;

/**
 * Writes base64 from stdin to "$1" as bytes, making its folder. macOS before
 * 13 spells the decode flag -D.
 */
const SAVE_SCRIPT = `
mkdir -p "$(dirname "$1")" || exit 1
cat > "$1.b64"
base64 -d < "$1.b64" > "$1" 2>/dev/null || base64 -D < "$1.b64" > "$1"
ok=$?; rm -f "$1.b64"; exit $ok
`;

type Os = "wsl" | "mac" | "linux" | "windows";
type Thumbnail = { width?: number; height?: number; preview?: PeekPreview };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

const isImageBlock = (block: unknown): block is ImageBlock => {
  const b = block as Partial<ImageBlock> | null;
  return (
    b?.type === "image" &&
    b.source?.type === "base64" &&
    typeof b.source.data === "string"
  );
};

const textOf = (content: readonly unknown[]) =>
  content
    .map((b) => {
      const block = b as { type?: string; text?: string };
      return block.type === "text" ? (block.text ?? "") : "";
    })
    .join("");

const tilde = (path: string, home: string | undefined) =>
  home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

const dirname = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** Which desktop this session runs on; asked once per load. */
let os: Promise<Os> | undefined;

async function detectOs($: EngineInterface): Promise<Os> {
  if (await $.env.get("WSL_DISTRO_NAME")) return "wsl";
  if ((await $.env.get("OS")) === "Windows_NT") return "windows";
  try {
    const { stdout } = await $.process.run(["uname", "-s"]);
    return stdout.includes("Darwin") ? "mac" : "linux";
  } catch {
    return "linux";
  }
}

function where($: EngineInterface): Promise<Os> {
  os ??= detectOs($);
  return os;
}

/** Whether the terminal draws kitty graphics; asked once per load. */
let graphics: Promise<boolean> | undefined;

async function detectGraphics($: EngineInterface): Promise<boolean> {
  // A multiplexer between Claude Code and the terminal drops the protocol.
  const multiplexed =
    (await $.env.get("TMUX")) ||
    (await $.env.get("STY")) ||
    (await $.env.get("ZELLIJ")) ||
    (await $.env.get("HERDR_ENV"));
  if (multiplexed) return false;
  const program = ((await $.env.get("TERM_PROGRAM")) ?? "").toLowerCase();
  const term = (await $.env.get("TERM")) ?? "";
  return (
    Boolean(await $.env.get("KITTY_WINDOW_ID")) ||
    program === "ghostty" ||
    /kitty|ghostty/.test(term)
  );
}

/** `image` draws the picture itself, `blocks` the half-block preview. */
async function previewMode(
  $: EngineInterface,
  setting: string,
): Promise<"image" | "blocks"> {
  if (setting === "image" || setting === "blocks") return setting;
  graphics ??= detectGraphics($);
  return (await graphics) ? "image" : "blocks";
}

/** The cell box a sharp image fits in, a cell being twice as tall as wide. */
function imageBox(img: PeekImage) {
  if (!img.width || !img.height) return undefined;
  let columns = IMAGE_COLUMNS;
  let rows = Math.round((columns * img.height) / img.width / 2);
  if (rows > IMAGE_ROWS) {
    rows = IMAGE_ROWS;
    columns = Math.round((rows * 2 * img.width) / img.height);
  }
  return { columns: Math.max(1, columns), rows: Math.max(1, rows) };
}

async function windowsPath($: EngineInterface, path: string) {
  return (await $.process.run(["wslpath", "-w", path])).stdout.trim();
}

/** Shows the file selected in Explorer (WSL, Windows) or Finder (macOS). */
async function revealFile($: EngineInterface, path: string): Promise<string> {
  switch (await where($)) {
    case "wsl":
      // explorer.exe exits 1 even when it worked.
      await $.process.run([
        "explorer.exe",
        `/select,${await windowsPath($, path)}`,
      ]);
      return "Explorer";
    case "windows":
      await $.process.run(["explorer.exe", `/select,${path}`]);
      return "Explorer";
    case "mac":
      await $.process.run(["open", "-R", path]);
      return "Finder";
    case "linux": {
      const shown = await $.process
        .run([
          "dbus-send",
          "--session",
          "--dest=org.freedesktop.FileManager1",
          "--type=method_call",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          `array:string:file://${encodeURI(path)}`,
          "string:",
        ])
        .catch(() => ({ exitCode: 1 }));
      if (shown.exitCode !== 0)
        await $.process.run(["xdg-open", dirname(path)]);
      return "the file manager";
    }
  }
}

/** Opens the file in the app the desktop associates with it. */
async function openFile($: EngineInterface, path: string): Promise<void> {
  switch (await where($)) {
    case "wsl":
      await $.process.run(["explorer.exe", await windowsPath($, path)]);
      return;
    case "windows":
      await $.process.run(["cmd.exe", "/c", "start", "", path]);
      return;
    case "mac":
      await $.process.run(["open", path]);
      return;
    case "linux":
      await $.process.run(["xdg-open", path]);
      return;
  }
}

/** Opens or reveals one image, says so in a toast, and answers the same words. */
async function act(
  $: EngineInterface,
  verb: "open" | "reveal",
  img: PeekImage,
): Promise<string> {
  try {
    if (verb === "open") {
      await openFile($, img.path);
      $.ui.toast(`Opened #${img.n} ${img.label}`);
      return `Opened #${img.n} (${img.path}).`;
    }
    const app = await revealFile($, img.path);
    $.ui.toast(`Revealed #${img.n} in ${app}`);
    return `Revealed #${img.n} in ${app} (${img.path}).`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    $.ui.toast(`Could not ${verb} #${img.n}: ${why}`);
    return `Could not ${verb} #${img.n}: ${why}`;
  }
}

/** The plain raster formats a preview is made from, by extension. */
const PREVIEW_FORMATS: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
};

const formatOf = (path: string): string | undefined =>
  PREVIEW_FORMATS[path.split(".").at(-1)?.toLowerCase() ?? ""];

async function thumbnail($: EngineInterface, path: string): Promise<Thumbnail> {
  const format = formatOf(path);
  if (!path.startsWith("/") || !format) return {};
  try {
    const { exitCode, stdout } = await $.process.run(
      [
        "sh",
        "-c",
        PREVIEW_SCRIPT,
        "sh",
        path,
        String(PREVIEW_WIDTH),
        String(PREVIEW_HEIGHT),
        format,
      ],
      { timeoutMs: 15_000 },
    );
    if (exitCode !== 0) return {};
    const [size = "", picture = ""] = stdout.split("\n");
    const [width, height] = size.trim().split(/[ x]/).map(Number);
    return {
      width: width || undefined,
      height: height || undefined,
      preview: picture.trim()
        ? decodePreview(fromBase64(picture.trim()))
        : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Writes a PNG copy of a non-PNG image, as `name` in today's folder, when
 * images are drawn sharp, and answers its path; nothing when it is a PNG
 * already or the copy failed, which leaves the half-block preview.
 */
async function pngCopy(
  $: EngineInterface,
  path: string,
  name: string,
  setting: string,
): Promise<{ png?: string }> {
  const format = formatOf(path);
  if (!path.startsWith("/") || !format || format === "png") return {};
  if ((await previewMode($, setting)) !== "image") return {};
  const out = `${await todayDir($)}/${name}`;
  const made = await $.process
    .run(["sh", "-c", PNG_SCRIPT, "sh", path, out, format], {
      timeoutMs: 30_000,
    })
    .catch(() => ({ exitCode: 1 }));
  return made.exitCode === 0 ? { png: out } : {};
}

/** Where the mod keeps its files today: pasted images and PNG copies. */
async function todayDir($: EngineInterface) {
  const home = await $.env.get("HOME");
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10);
  return `${home ?? "/tmp"}/.claude/image-peek/${day}`;
}

/** Numbers the images and adds them to the session's list. */
async function remember($: EngineInterface, found: Omit<PeekImage, "n">[]) {
  if (found.length === 0) return;
  let first = 0;
  await update($, seq, (last) => {
    first = last + 1;
    return last + found.length;
  });
  const numbered = found.map((img, i) => ({ ...img, n: first + i }));
  await update($, images, (list) => [...list, ...numbered].slice(-KEEP));
}

/** One card per image: the half-block preview, its label, Open and Reveal. */
async function cards(
  $: EngineInterface,
  e: RenderInput,
  mine: PeekImage[],
  setting: string,
) {
  const home = await $.env.get("HOME");
  const { Box, Text, Button } = $.ui.resolve(e);
  const terminal = e.surface === "terminal" ? $.ui.resolve(e) : undefined;
  const Raster = terminal?.Raster;
  const Image = terminal?.Image;
  const sharp = terminal && (await previewMode($, setting)) === "image";

  return mine.map((img) => {
    // The terminal reads the file itself, and only a PNG.
    const png = /\.png$/i.test(img.path) ? img.path : img.png;
    const box = sharp && png ? imageBox(img) : undefined;
    return (
    <Box key={`card-${img.n}`} flexDirection="column" paddingLeft={2}>
      {Image && box && png && (
        <Image
          key={`image-${img.n}`}
          source={{ file: png, format: "png" }}
          columns={box.columns}
          rows={box.rows}
          alt={`${img.label} (${img.width}×${img.height})`}
        />
      )}
      {Raster && !box && img.preview && (
        <Raster
          key={`preview-${img.n}`}
          columns={img.preview.columns}
          rows={img.preview.rows}
          cells={img.preview.cells}
        />
      )}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          #{img.n} {img.label}
          {img.width && img.height ? ` · ${img.width}×${img.height}` : ""}
        </Text>
        <Button
          key={`open-${img.n}`}
          label="Open"
          onPress={() => void act($, "open", img)}
        />
        <Button
          key={`reveal-${img.n}`}
          label="Reveal"
          onPress={() => void act($, "reveal", img)}
        />
      </Box>
      <Text dimColor wrap="truncate-start">
        {tilde(img.path, home)}
      </Text>
    </Box>
    );
  });
}

/**
 * /reveal-image and /open-image. Hooked once per command with a matcher: a
 * hook with no matcher counts as answering every command, and its name shows
 * on every command's output.
 */
async function imageCommand($: EngineInterface, e: CommandRunInput) {
  const list = await read($, images);
  const asked = e.args.trim().replace(/^#/, "");
  const img = asked
    ? list.find((one) => one.n === Number(asked))
    : list.at(-1);
  if (!img) {
    return {
      text:
        list.length === 0
          ? "No images yet: paste one, or ask Claude to send one."
          : `No image #${asked}. Known: ${list.map((one) => `#${one.n}`).join(", ")}.`,
    };
  }
  return {
    text: await act($, e.command === "open-image" ? "open" : "reveal", img),
  };
}

export const register: Register = (on, options) => {
  const setting = String(options.preview ?? "auto");

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "reveal-image",
      description:
        "Reveal an image in Explorer/Finder (latest, or #n from its card)",
      argumentHint: "[n]",
    });
    await $.command.register({
      name: "open-image",
      description:
        "Open an image in its default app (latest, or #n from its card)",
      argumentHint: "[n]",
    });
    return next(e);
  });

  on("command.run", { command: "reveal-image" }, imageCommand);
  on("command.run", { command: "open-image" }, imageCommand);

  // A pasted image lives only inside the prompt row, as base64: keep a copy
  // on disk so there is a file to open and reveal.
  on("session.append", { door: "prompt" }, async ($, e, next) => {
    const stored = await next(e);
    const content = e.message.content as readonly unknown[];
    const blocks = content.filter(isImageBlock);
    if (blocks.length === 0 || e.agentId) return stored;

    const dir = await todayDir($);
    const prompt = textOf(content);
    const numbers = [...prompt.matchAll(/\[Image #(\d+)\]/g)].map((m) => m[1]);

    const found: Omit<PeekImage, "n">[] = [];
    for (const [i, block] of blocks.entries()) {
      const name = `${e.uuid.slice(0, 8)}-${i + 1}.${extensionFor(block.source.media_type)}`;
      const path = `${dir}/${name}`;
      const saved = await $.process
        .run(["sh", "-c", SAVE_SCRIPT, "sh", path], {
          stdin: block.source.data,
          timeoutMs: 30_000,
        })
        .catch(() => ({ exitCode: 1 }));
      if (saved.exitCode !== 0) continue;
      found.push({
        row: e.uuid,
        prompt,
        path,
        label: `Image #${numbers[i] ?? i + 1}`,
        from: "pasted",
        ...(await thumbnail($, path)),
        ...(await pngCopy($, path, name.replace(/\.[^.]*$/, ".png"), setting)),
      });
    }
    await remember($, found);
    return stored;
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: "SendUserFile" }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined || ran.isError) return ran;

    const result = ran.result as
      { attachments?: { path: string; isImage?: boolean }[] } | undefined;
    const paths = result?.attachments
      ? result.attachments
          .filter((a) => a.isImage || isImagePath(a.path))
          .map((a) => a.path)
      : e.files.filter(isImagePath);

    const found: Omit<PeekImage, "n">[] = [];
    for (const [i, given] of paths.entries()) {
      // Open, Reveal and the preview only ever get an absolute path.
      const path = given.startsWith("/")
        ? given
        : (
            await $.process
              .run(["realpath", "--", given])
              .catch(() => ({ exitCode: 1, stdout: "" }))
          ).stdout.trim();
      if (!path.startsWith("/")) continue;
      found.push({
        row: e.tool_use_id,
        path,
        label: path.split("/").at(-1) ?? path,
        from: "claude",
        ...(await thumbnail($, path)),
        ...(await pngCopy($, path, `${e.tool_use_id}-${i + 1}.png`, setting)),
      });
    }
    await remember($, found);
    return ran;
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const list = await read($, images);
    let mine = list.filter((img) => img.row === e.requestId);
    // The row's id should be the prompt's uuid; match on its text if not.
    if (mine.length === 0 && e.props.text.includes("[Image #")) {
      const last = [...list]
        .reverse()
        .find((img) => img.from === "pasted" && img.prompt === e.props.text);
      mine = last ? list.filter((img) => img.row === last.row) : [];
    }
    if (mine.length === 0) return next(e);

    const { Box } = $.ui.resolve(e);
    const own = await next(e);
    return (
      <Box flexDirection="column">
        {own}
        {await cards($, e, mine, setting)}
      </Box>
    );
  });

  on(
    "ui.render",
    { component: "ToolUse", props: { tool: "SendUserFile" } },
    async ($, e, next) => {
      const mine = (await read($, images)).filter(
        (img) => img.row === e.requestId,
      );
      if (mine.length === 0) return next(e);

      const { Box } = $.ui.resolve(e);
      const own = await next(e);
      return (
        <Box flexDirection="column">
          {own}
          {await cards($, e, mine, setting)}
        </Box>
      );
    },
  );
};
