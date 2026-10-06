import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, RenderInput } from "claude-code";

import type { Preview } from "../types";
import { decodePreview, fromBase64 } from "./preview";
import {
  countsOf,
  findRefs,
  labelOf,
  parseRecord,
  resolveRefs,
  type ProofRecord,
  type Result,
} from "./record";

/** A thumbnail's box: pixels for the blocks, cells for a sharp picture. */
const THUMB_WIDTH = 44;
const THUMB_HEIGHT = 28;
/** How long a scan of the records folder is reused before it is read again. */
const INDEX_TTL_MS = 10_000;
/** How many records one reply shows a button for. */
const MAX_PER_REPLY = 3;

const open = atom({ plugin: "pr-proof", key: "open" } as const, []);

/**
 * `blocks` prints `<w> <h>` then a half-block-sized PPM as base64; `image`
 * prints the size then a PNG of at most 960×600 as base64. Exits non-zero
 * when ImageMagick is missing.
 *
 * "$1" is always an absolute path and "$4" the format its extension names,
 * forced on ImageMagick ("png:/path") so no prefix or content-sniffed coder runs.
 */
const THUMB_SCRIPT = `
f="$1"; w="$2"; h="$3"; t="$4"; mode="$5"
case "$f" in /*) ;; *) exit 2 ;; esac
# Windows' own convert.exe (FAT to NTFS) is on a WSL PATH: not ImageMagick.
has() { p=$(command -v "$1" 2>/dev/null) && case "$p" in /mnt/*) false ;; esac; }
if has magick; then id() { magick identify "$@"; }; cv() { magick "$@"; }
elif has convert && has identify; then id() { identify "$@"; }; cv() { convert "$@"; }
else exit 3; fi
id -format "%w %h\\n" "$t:$f[0]" 2>/dev/null | head -n 1
if [ "$mode" = image ]; then
  cv "$t:$f[0]" -auto-orient -thumbnail "960x600>" png:- | base64 | tr -d '\\n'
else
  cv "$t:$f[0]" -auto-orient -thumbnail "\${w}x\${h}" -background "#000000" -alpha remove -alpha off -depth 8 ppm:- | base64 | tr -d '\\n'
fi
`;

type Os = "wsl" | "mac" | "linux" | "windows";
type Mode = "image" | "blocks";
type Thumb = {
  width?: number;
  height?: number;
  preview?: Preview;
  png?: string;
};

const FORMATS: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
};

/** The PNG signature, as base64 begins it. */
const PNG_BASE64 = "iVBORw0KGgo";

const dirname = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

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

async function modeFor($: EngineInterface, setting: string): Promise<Mode> {
  if (setting === "image" || setting === "blocks") return setting;
  graphics ??= detectGraphics($);
  return (await graphics) ? "image" : "blocks";
}

async function windowsPath($: EngineInterface, path: string) {
  return (await $.process.run(["wslpath", "-w", path])).stdout.trim();
}

/** Shows the path selected in Explorer (WSL, Windows) or Finder (macOS). */
async function reveal($: EngineInterface, path: string): Promise<string> {
  os ??= detectOs($);
  switch (await os) {
    case "wsl":
      // explorer.exe exits 1 even when it worked.
      await $.process.run(["explorer.exe", `/select,${await windowsPath($, path)}`]);
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
      if (shown.exitCode !== 0) await $.process.run(["xdg-open", dirname(path)]);
      return "the file manager";
    }
  }
}

/** Opens the file in the app the desktop associates with it. */
async function openFile($: EngineInterface, path: string): Promise<void> {
  os ??= detectOs($);
  switch (await os) {
    case "wsl":
      await $.process.run(["explorer.exe", await windowsPath($, path)]);
      return;
    case "windows":
      // Never cmd.exe: it parses the path again, so `&` in a folder name runs.
      await $.process.run(["explorer.exe", path]);
      return;
    case "mac":
      await $.process.run(["open", path]);
      return;
    case "linux":
      await $.process.run(["xdg-open", path]);
      return;
  }
}

/** The file's own extension, from its name alone. */
const extensionOf = (path: string) => {
  const name = path.split("/").at(-1) ?? "";
  return name.includes(".") ? (name.split(".").at(-1)?.toLowerCase() ?? "") : "";
};

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * What Open hands to the desktop's default app, and the bytes each must start
 * with: `[offset, bytes]` pairs that all have to match. A record is only data,
 * and an executable (`.command`, `.bat`, `.desktop`, `.app`) would run when
 * opened, so anything else is revealed instead.
 */
const PICTURES: Record<string, [number, number[]][][]> = {
  png: [[[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]]],
  jpg: [[[0, [0xff, 0xd8, 0xff]]]],
  jpeg: [[[0, [0xff, 0xd8, 0xff]]]],
  gif: [[[0, ascii("GIF87a")]], [[0, ascii("GIF89a")]]],
  webp: [[[0, ascii("RIFF")], [8, ascii("WEBP")]]],
  bmp: [[[0, ascii("BM")]]],
  mp4: [[[4, ascii("ftyp")]]],
  mov: [[[4, ascii("ftyp")]]],
  webm: [[[0, [0x1a, 0x45, 0xdf, 0xa3]]]],
};
const TEXT = new Set(["json", "txt", "md", "log", "csv"]);

/** Whether the bytes are what this extension says: its own signature, or plain text. */
function looksLike(extension: string, bytes: Uint8Array): boolean {
  if (TEXT.has(extension)) {
    const head = bytes.subarray(0, 4096);
    // A script or a desktop entry renamed to .txt is not text to open.
    const start = new TextDecoder().decode(head.subarray(0, 64));
    return !head.includes(0) && !start.startsWith("#!") && !start.includes("[Desktop Entry]");
  }
  const forms = PICTURES[extension] ?? [];
  return forms.some((form) => form.every(([at, sig]) => sig.every((b, i) => bytes[at + i] === b)));
}

/**
 * The real path to open, or undefined to reveal instead. Open takes only a
 * regular file, not a link, that resolves inside the record's own folder (no
 * linked folder above it leads out) under a viewable extension; on Linux,
 * where xdg-open can go by content, its bytes must match that extension too.
 * The opener gets the resolved path that was checked, never the given one.
 */
async function openable($: EngineInterface, path: string, within: string): Promise<string | undefined> {
  const extension = extensionOf(path);
  if (!TEXT.has(extension) && !PICTURES[extension]) return undefined;
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  const home = await $.fs.stat(within, { resolve: true }).catch(() => undefined);
  const real = stat?.realPath;
  const root = home?.realPath;
  if (!stat || stat.kind !== "file" || stat.isLink || !real || !root) return undefined;
  if (!real.startsWith(`${root.replace(/\/+$/, "")}/`) || extensionOf(real) !== extension) return undefined;
  os ??= detectOs($);
  if ((await os) !== "linux") return real;
  const read = await $.fs.read(real, { as: "bytes" }).catch(() => undefined);
  return read && looksLike(extension, fromBase64(read.base64)) ? real : undefined;
}

/** Opens a record's file (when it is safe to) or reveals it, and says which. */
async function act(
  $: EngineInterface,
  asked: "open" | "reveal",
  path: string,
  within: string,
): Promise<string> {
  const name = path.split("/").at(-1) ?? path;
  const real = asked === "open" ? await openable($, path, within) : undefined;
  const verb = real ? "open" : "reveal";
  try {
    if (real) {
      await openFile($, real);
      $.ui.toast(`Opened ${name}`);
      return `Opened ${real}.`;
    }
    const app = await reveal($, path);
    $.ui.toast(`Revealed ${name} in ${app}`);
    return `Revealed ${path} in ${app}.`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    $.ui.toast(`Could not ${verb} ${name}: ${why}`);
    return `Could not ${verb} ${path}: ${why}`;
  }
}

const thumbs = new Map<string, Promise<Thumb>>();

async function makeThumb($: EngineInterface, path: string, mode: Mode): Promise<Thumb> {
  const format = FORMATS[path.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!path.startsWith("/") || !format) return {};
  try {
    const { exitCode, stdout } = await $.process.run(
      ["sh", "-c", THUMB_SCRIPT, "sh", path, String(THUMB_WIDTH), String(THUMB_HEIGHT), format, mode],
      { timeoutMs: 15_000 },
    );
    if (exitCode !== 0) return {};
    const [size = "", picture = ""] = stdout.split("\n");
    const [width, height] = size.trim().split(/[ x]/).map(Number);
    const data = picture.trim();
    return {
      width: width || undefined,
      height: height || undefined,
      // A non-PNG source makes the engine refuse the whole reply's drawing.
      ...(data && mode === "image" && data.startsWith(PNG_BASE64) ? { png: data } : {}),
      ...(data && mode === "blocks" ? { preview: decodePreview(fromBase64(data)) } : {}),
    };
  } catch {
    return {};
  }
}

function thumb($: EngineInterface, path: string, mode: Mode): Promise<Thumb> {
  const key = `${mode}:${path}`;
  let made = thumbs.get(key);
  if (!made) {
    made = makeThumb($, path, mode);
    thumbs.set(key, made);
  }
  return made;
}

let index: { at: number; root: string; records: Promise<ProofRecord[]> } | undefined;

async function scan($: EngineInterface, root: string): Promise<ProofRecord[]> {
  const records: ProofRecord[] = [];
  const repos = await $.fs.list(root).catch(() => []);
  for (const repo of repos) {
    // The folder name ends up in paths handed to the OS: plain names only.
    if (repo.kind !== "dir" || !/^[\w][\w.-]*$/.test(repo.name)) continue;
    const prs = await $.fs.list(`${root}/${repo.name}`).catch(() => []);
    for (const pr of prs) {
      if (pr.kind !== "dir" || !/^\d+$/.test(pr.name)) continue;
      const dir = `${root}/${repo.name}/${pr.name}`;
      const text = await $.fs.read(`${dir}/proof.json`).catch(() => undefined);
      const record = text && parseRecord(text, dir, repo.name, Number(pr.name));
      if (record) records.push(record);
    }
  }
  return records;
}

async function recordsIn($: EngineInterface, root: string, fresh = false) {
  const now = await $.clock.now();
  if (fresh || !index || index.root !== root || now - index.at > INDEX_TTL_MS) {
    index = { at: now, root, records: scan($, root) };
  }
  return index.records;
}

let here: Promise<string | undefined> | undefined;

/** The name of the repo the session runs in, for a bare `#541`. */
async function repoHere($: EngineInterface): Promise<string | undefined> {
  here ??= $.process
    .run(["git", "rev-parse", "--show-toplevel"])
    .then((r) => (r.exitCode === 0 ? r.stdout.trim().split("/").at(-1) : undefined))
    .catch(() => undefined);
  return here;
}

async function rootOf($: EngineInterface, setting: string): Promise<string> {
  const home = (await $.env.get("HOME")) ?? "";
  const root = setting.replace(/^~(?=$|\/)/, home).replace(/\/+$/, "");
  return root || `${home}/pr-proof`;
}

const MARK: Record<Result, { glyph: string; color: string }> = {
  pass: { glyph: "✓", color: "success" },
  fail: { glyph: "✗", color: "error" },
  skip: { glyph: "!", color: "warning" },
};

/** One picture: sharp on kitty or Ghostty, blocks elsewhere, its name and buttons. */
async function picture(
  $: EngineInterface,
  e: RenderInput,
  key: string,
  label: string,
  path: string,
  within: string,
  mode: Mode,
) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const terminal = e.surface === "terminal" ? $.ui.resolve(e) : undefined;
  const Image = terminal?.Image;
  const Raster = terminal?.Raster;
  const t: Thumb = terminal ? await thumb($, path, mode) : {};
  const rows =
    t.width && t.height
      ? Math.max(1, Math.min(24, Math.round((THUMB_WIDTH * t.height) / t.width / 2)))
      : 0;
  return (
    <Box key={`pic-${key}`} flexDirection="column" width={THUMB_WIDTH}>
      {Image && t.png && rows > 0 && (
        <Image
          key={`img-${key}`}
          source={{ png: t.png }}
          columns={THUMB_WIDTH}
          rows={rows}
          alt={label}
        />
      )}
      {Raster && !t.png && t.preview && (
        <Raster
          key={`raster-${key}`}
          columns={t.preview.columns}
          rows={t.preview.rows}
          cells={t.preview.cells}
        />
      )}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{label}</Text>
        <Button key={`open-${key}`} label="Open" onPress={() => void act($, "open", path, within)} />
        <Button key={`reveal-${key}`} label="Reveal" onPress={() => void act($, "reveal", path, within)} />
      </Box>
    </Box>
  );
}

async function details($: EngineInterface, e: RenderInput, r: ProofRecord, id: string, mode: Mode) {
  const { Box, Text, Button, Link } = $.ui.resolve(e);
  const counts = { pass: 0, fail: 0, skip: r.notChecked.length };
  for (const c of r.checks) counts[c.result]++;

  const changes = [];
  for (const [i, c] of r.changes.entries()) {
    const sides = [];
    if (c.before)
      sides.push(await picture($, e, `${id}-c${i}-before`, "Before", `${r.dir}/${c.before}`, r.dir, mode));
    else sides.push(<Text key={`${id}-c${i}-nobefore`} dimColor>(no before shot)</Text>);
    if (c.after)
      sides.push(await picture($, e, `${id}-c${i}-after`, "After", `${r.dir}/${c.after}`, r.dir, mode));
    changes.push(
      <Box key={`${id}-c${i}`} flexDirection="column">
        <Text bold>{c.title}</Text>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {sides}
        </Box>
      </Box>,
    );
  }

  return (
    <Box key={`${id}-details`} flexDirection="column" gap={1} paddingLeft={2}>
      <Box flexDirection="row" gap={2}>
        <Text color="success">✓ {counts.pass} passed</Text>
        {counts.fail > 0 && <Text color="error">✗ {counts.fail} failed</Text>}
        {counts.skip > 0 && <Text color="warning">! {counts.skip} not checked</Text>}
      </Box>
      {changes.length > 0 && <Box flexDirection="column" gap={1}>{changes}</Box>}
      {r.checks.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Checks</Text>
          {r.checks.map((c, i) => (
            <Box key={`${id}-k${i}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text color={MARK[c.result].color}>{MARK[c.result].glyph}</Text>
              <Text>{c.claim}</Text>
              {c.where && <Text dimColor>· {c.where}</Text>}
              {c.evidence.map((name, j) => (
                <Button
                  key={`${id}-k${i}-e${j}`}
                  label={name}
                  plain
                  dimColor
                  onPress={() => void act($, "open", `${r.dir}/${name}`, r.dir)}
                />
              ))}
            </Box>
          ))}
        </Box>
      )}
      {r.notChecked.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Not checked</Text>
          {r.notChecked.map((n, i) => (
            <Box key={`${id}-n${i}`} flexDirection="row" gap={1}>
              <Text color="warning">!</Text>
              <Text>{n}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row" gap={2}>
        <Button
          key={`${id}-folder`}
          label="Reveal folder"
          onPress={() => void act($, "reveal", `${r.dir}/proof.json`, r.dir)}
        />
        {r.url && <Link href={r.url} label="Open the PR" />}
      </Box>
    </Box>
  );
}

export const register: Register = (on, options) => {
  const rootSetting = String(options.root ?? "~/pr-proof");
  const previewSetting = String(options.preview ?? "auto");

  // The records folder is a setting, so the agent writing records reads it
  // from here rather than from the skill's default.
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    const root = await rootOf($, rootSetting);
    return {
      sections: [
        ...composed.sections,
        {
          id: "pr-proof:root",
          text: `PR proof records (the pr-proof:record-proof skill) go in ${root}/<repo>/<pr>/: proof.json beside its screenshots and files.`,
          scope: "session" as const,
        },
      ],
    };
  });

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "proof",
      description: "List the PR proof records, or reveal one's folder (name#541)",
      argumentHint: "[name#pr]",
    });
    return next(e);
  });

  // Matched to its own command: a hook with no matcher counts as answering every
  // command, and its name shows on every command's output.
  on("command.run", { command: "proof" }, async ($, e) => {
    const root = await rootOf($, rootSetting);
    const records = await recordsIn($, root, true);
    const asked = e.args.trim();
    if (asked) {
      const hit = resolveRefs(findRefs(asked.includes("#") ? asked : `#${asked}`), records, await repoHere($))[0];
      if (!hit) return { text: `No record for ${asked} under ${root}.` };
      return { text: await act($, "reveal", `${hit.dir}/proof.json`, hit.dir) };
    }
    if (records.length === 0)
      return { text: `No records under ${root}. Each one is <root>/<repo>/<pr>/proof.json.` };
    return {
      text: records
        .map((r) => `${labelOf(r)}  ${countsOf(r)}${r.title ? `  ${r.title}` : ""}`)
        .join("\n"),
    };
  });

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const refs = findRefs(e.props.text);
    if (refs.length === 0) return next(e);
    const root = await rootOf($, rootSetting);
    const found = resolveRefs(refs, await recordsIn($, root), await repoHere($)).slice(0, MAX_PER_REPLY);
    if (found.length === 0) return next(e);

    const { Box, Text, Button } = $.ui.resolve(e);
    const own = await next(e);
    const opened = await read($, open);
    const mode = await modeFor($, previewSetting);

    const blocks = [];
    for (const r of found) {
      const id = `${r.dir}@${e.requestId}`;
      const isOpen = opened.includes(id);
      const key = `pp-${r.repoDir}-${r.pr}`;
      blocks.push(
        <Box key={key} flexDirection="column" paddingLeft={2}>
          <Box flexDirection="row" gap={1}>
            <Button
              key={`${key}-toggle`}
              label={isOpen ? "▾ Hide proof" : "▸ Reveal proof"}
              onPress={() =>
                void update($, open, (list) =>
                  list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-40),
                )
              }
            />
            <Text dimColor>
              {labelOf(r)} · {countsOf(r)}
            </Text>
          </Box>
          {isOpen && (await details($, e, r, key, mode))}
        </Box>,
      );
    }
    return (
      <Box flexDirection="column">
        {own}
        {blocks}
      </Box>
    );
  });
};
