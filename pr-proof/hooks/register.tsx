import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, RenderElement, RenderInput } from "claude-code";

import type { Preview } from "../types";
import { decodePreview, fromBase64 } from "./preview";
import {
  countsOf,
  findRecordPaths,
  findRefs,
  findUrlRefs,
  ghPrText,
  labelOf,
  outputText,
  parseRecord,
  parseRefKey,
  refKey,
  resolveRefs,
  type ProofRecord,
  type Ref,
  type Result,
} from "./record";

/** A picture's width in cells: the narrowest, the widest, and its height box per cell across (blocks are 2 pixels tall). */
const MIN_THUMB_WIDTH = 44;
const MAX_THUMB_WIDTH = 80;
const THUMB_ASPECT = 28 / 44;

/**
 * As wide as two pictures side by side fit the transcript (a change's before
 * and after), between the narrowest and the widest: 8 cells go to the two
 * indents and the gap between them.
 */
function thumbWidthFor(columns: number | undefined): number {
  if (!columns) return MIN_THUMB_WIDTH;
  return Math.max(MIN_THUMB_WIDTH, Math.min(MAX_THUMB_WIDTH, Math.floor((columns - 8) / 2)));
}
/** How long a scan of the records folder is reused before it is read again. */
const INDEX_TTL_MS = 10_000;
/** How many records one reply shows a button for. */
const MAX_PER_REPLY = 5;

const open = atom({ plugin: "pr-proof", key: "open" } as const, []);
const seen = atom({ plugin: "pr-proof", key: "seen" } as const, []);

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

async function makeThumb($: EngineInterface, path: string, mode: Mode, width: number): Promise<Thumb> {
  const format = FORMATS[path.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!path.startsWith("/") || !format) return {};
  try {
    const { exitCode, stdout } = await $.process.run(
      ["sh", "-c", THUMB_SCRIPT, "sh", path, String(width), String(Math.round(width * THUMB_ASPECT)), format, mode],
      { timeoutMs: 15_000 },
    );
    if (exitCode !== 0) return {};
    const [size = "", picture = ""] = stdout.split("\n");
    const [sourceWidth, sourceHeight] = size.trim().split(/[ x]/).map(Number);
    const data = picture.trim();
    return {
      width: sourceWidth || undefined,
      height: sourceHeight || undefined,
      // A non-PNG source makes the engine refuse the whole reply's drawing.
      ...(data && mode === "image" && data.startsWith(PNG_BASE64) ? { png: data } : {}),
      ...(data && mode === "blocks" ? { preview: decodePreview(fromBase64(data)) } : {}),
    };
  } catch {
    return {};
  }
}

function thumb($: EngineInterface, path: string, mode: Mode, width: number): Promise<Thumb> {
  const key = `${mode}:${width}:${path}`;
  let made = thumbs.get(key);
  if (!made) {
    made = makeThumb($, path, mode, width);
    thumbs.set(key, made);
  }
  return made;
}

/**
 * Each record's mentions, in the order they were first drawn: a reply, or a
 * `gh pr create` row. Only the newest draws the button, so one PR shows one.
 * A module variable, not `$.state`: a render hook cannot write, and a reload
 * draws every row again, which rebuilds it in the same order.
 */
const mentions = new Map<string, string[]>();

/** Whether `instance` is now the record's newest mention, and whether it just displaced an older one. */
function newestMention(dir: string, instance: string): { isNewest: boolean; displaced: boolean } {
  const list = mentions.get(dir) ?? [];
  const isNew = !list.includes(instance);
  if (isNew) mentions.set(dir, [...list, instance].slice(-200));
  return { isNewest: (mentions.get(dir) ?? []).at(-1) === instance, displaced: isNew && list.length > 0 };
}

/** How long an open PR's state is trusted before `gh` is asked again; a merged one is final. */
const OPEN_STATE_TTL_MS = 5 * 60_000;
/** How long a drawing waits on `gh` before drawing the button and checking behind it. */
const STATE_WAIT_MS = 1_500;

/** Where a PR stands: open (worth reviewing), done (merged or closed), or no PR `gh` can find. */
type PrState = "open" | "done" | "unknown";

const prStates = new Map<string, { at: number; state: Promise<PrState> }>();

async function askState($: EngineInterface, slug: string, pr: number): Promise<PrState> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return "unknown";
  try {
    const { exitCode, stdout } = await $.process.run(
      ["gh", "api", `repos/${slug}/pulls/${pr}`, "--jq", ".state"],
      { timeoutMs: 10_000 },
    );
    if (exitCode !== 0) return "unknown";
    return stdout.trim() === "open" ? "open" : "done";
  } catch {
    return "unknown";
  }
}

/**
 * The PR's state if `gh` answers within STATE_WAIT_MS, else `whileWaiting`
 * and a redraw once it answers. A done PR stays done, so its answer is kept
 * for the session; any other is asked again after OPEN_STATE_TTL_MS.
 */
async function prState($: EngineInterface, slug: string, pr: number, whileWaiting: PrState): Promise<PrState> {
  const key = `${slug}#${pr}`;
  const now = await $.clock.now();
  let known = prStates.get(key);
  if (!known || now - known.at > OPEN_STATE_TTL_MS) {
    const state = askState($, slug, pr);
    known = { at: now, state };
    prStates.set(key, known);
    void state.then((st) => {
      if (st === "done") prStates.set(key, { at: Number.MAX_SAFE_INTEGER, state });
    });
  }
  const late = Symbol("late");
  const wait = new AbortController();
  const answer = await Promise.race([
    known.state,
    new Promise<typeof late>((resolve) =>
      void $.clock.sleep(STATE_WAIT_MS, { signal: wait.signal }).then(
        () => resolve(late),
        () => undefined,
      ),
    ),
  ]);
  wait.abort();
  if (answer !== late) return answer;
  void known.state.then((st) => st !== whileWaiting && $.ui.invalidate("ui.render"));
  return whileWaiting;
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
  width: number,
) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const terminal = e.surface === "terminal" ? $.ui.resolve(e) : undefined;
  const Image = terminal?.Image;
  const Raster = terminal?.Raster;
  const t: Thumb = terminal ? await thumb($, path, mode, width) : {};
  const rows =
    t.width && t.height
      ? Math.max(1, Math.min(Math.round(width * THUMB_ASPECT), Math.round((width * t.height) / t.width / 2)))
      : 0;
  return (
    <Box key={`pic-${key}`} flexDirection="column" width={width}>
      {Image && t.png && rows > 0 && (
        <Image
          key={`img-${key}`}
          source={{ png: t.png }}
          columns={width}
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

async function details(
  $: EngineInterface,
  e: RenderInput,
  r: ProofRecord,
  id: string,
  mode: Mode,
  hide: () => void,
) {
  const { Box, Text, Button, Link } = $.ui.resolve(e);
  const counts = { pass: 0, fail: 0, skip: r.notChecked.length };
  for (const c of r.checks) counts[c.result]++;

  const width = thumbWidthFor(e.viewport?.columns);
  const changes = [];
  for (const [i, c] of r.changes.entries()) {
    const sides = [];
    if (c.before)
      sides.push(await picture($, e, `${id}-c${i}-before`, "Before", `${r.dir}/${c.before}`, r.dir, mode, width));
    else sides.push(<Text key={`${id}-c${i}-nobefore`} dimColor>(no before shot)</Text>);
    if (c.after)
      sides.push(await picture($, e, `${id}-c${i}-after`, "After", `${r.dir}/${c.after}`, r.dir, mode, width));
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
        {/* A second Hide at the foot, so an open proof taller than the screen closes without scrolling back up. */}
        <Button key={`${id}-hide`} label="▴ Close" onPress={hide} />
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

/** The row as the engine draws it, with a proof button under it per record its refs find. */
async function withProof(
  $: EngineInterface,
  e: RenderInput,
  engineRow: () => Promise<RenderElement>,
  refs: Ref[],
  settings: { root: string; preview: string },
): Promise<RenderElement> {
  if (refs.length === 0) return engineRow();
  const root = await rootOf($, settings.root);
  const instance = `${e.component}:${e.requestId}`;
  let displaced = false;
  const records = await recordsIn($, root);
  const here = await repoHere($);
  const named = resolveRefs(refs, records, here);
  // A record's proof is worth a button while its PR is open; a done PR's is history.
  const live = [];
  for (const r of named) {
    if (!r.repo?.includes("/") || (await prState($, r.repo, r.pr, "open")) !== "done") live.push(r);
  }
  const newestOnly = (id: string) => {
    const newest = newestMention(id, instance);
    displaced ||= newest.displaced;
    return newest.isNewest;
  };
  const found = live.filter((r) => newestOnly(r.dir)).slice(0, MAX_PER_REPLY);
  // The rows that drew this record's button before draw again, without it.
  if (displaced) $.ui.invalidate("ui.render");
  if (found.length === 0) return engineRow();

  const { Box, Text, Button } = $.ui.resolve(e);
  const own = await engineRow();
  const opened = await read($, open);
  const mode = await modeFor($, settings.preview);

  const blocks = [];
  for (const r of found) {
    const id = `${r.dir}@${e.requestId}`;
    const isOpen = opened.includes(id);
    const key = `pp-${r.repoDir}-${r.pr}`;
    const toggle = () =>
      void update($, open, (list) =>
        list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-40),
      );
    blocks.push(
      <Box key={key} flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row" gap={1}>
          <Button key={`${key}-toggle`} label={isOpen ? "▾ Proof" : "▸ Proof"} onPress={toggle} />
          {/* The row sits under the line that names the PR: its name only tells two buttons apart. */}
          {found.length > 1 && <Text dimColor>{labelOf(r)}</Text>}
        </Box>
        {isOpen && (await details($, e, r, key, mode, toggle))}
      </Box>,
    );
  }
  return (
    <Box flexDirection="column">
      {own}
      {blocks}
    </Box>
  );
}

export const register: Register = (on, options) => {
  const rootSetting = String(options.root ?? "~/pr-proof");
  const previewSetting = String(options.preview ?? "auto");
  const settings = { root: rootSetting, preview: previewSetting };

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
    const line = (r: ProofRecord) => `${labelOf(r)}  ${countsOf(r)}${r.title ? `  ${r.title}` : ""}`;
    const refs = (await read($, seen)).map(parseRefKey).filter((r): r is Ref => !!r);
    const mine = resolveRefs(refs, records, await repoHere($));
    const rest = records.filter((r) => !mine.includes(r));
    if (mine.length === 0)
      return { text: ["None from this session yet.", "", "Other sessions:", ...rest.map(line)].join("\n") };
    return {
      text: [
        "This session:",
        ...mine.map(line),
        ...(rest.length ? ["", "Other sessions:", ...rest.map(line)] : []),
      ].join("\n"),
    };
  });

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    withProof($, e, () => next(e), findRefs(e.props.text), settings),
  );

  // Claude Code's own line for a `gh pr` call, "Created PR #549" or "Edited
  // PR #549", is a ToolUse row, or a ToolGroup when it folded the call with
  // others: the PR is in the URL the command printed.
  on("ui.render", { component: "ToolUse" }, async ($, e, next) =>
    withProof($, e, () => next(e), findUrlRefs(ghPrText(e.props.tool, e.props.input, e.props.output)), settings),
  );

  on("ui.render", { component: "ToolGroup" }, async ($, e, next) =>
    withProof(
      $,
      e,
      () => next(e),
      findUrlRefs(e.props.calls.map((c) => ghPrText(c.tool, c.input, c.output)).join("\n")),
      settings,
    ),
  );

  // What this session touched: a PR a command printed, a record a tool wrote or
  // named by its path. /proof lists these first.
  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    try {
      const root = await rootOf($, rootSetting);
      const home = (await $.env.get("HOME")) ?? "";
      // The fields that name what a call touched, not a Write's content, which
      // may mention any record.
      const args = e as unknown as Record<string, unknown>;
      const input = ["command", "file_path", "path"]
        .map((k) => args[k])
        .filter((v): v is string => typeof v === "string")
        .join("\n");
      const output = ran.deny === undefined ? outputText(e.tool, ran.result) : "";
      const refs = [...findRecordPaths(input, root, home), ...findUrlRefs(output)];
      if (refs.length > 0) {
        await update($, seen, (list) => {
          const keys = refs.map(refKey).filter((k) => !list.includes(k));
          return keys.length ? [...list, ...keys].slice(-100) : list;
        });
      }
      // A merge just happened: every cached state may be stale, and the rows
      // under a PR that is now merged draw again without their button.
      if (/\bgh\s+pr\s+merge\b/.test(input) && ran.deny === undefined) {
        prStates.clear();
        $.ui.invalidate("ui.render");
      }
      // A PR opened with no record yet: say so to the model once, while the
      // verification is fresh, rather than when someone asks for the proof.
      const created = /\bgh\s+pr\s+create\b/.test(input) ? findUrlRefs(output) : [];
      if (created.length > 0 && ran.deny === undefined && ran.isError !== true) {
        const records = await recordsIn($, root, true);
        const missing = created.filter((r) => resolveRefs([r], records, undefined).length === 0);
        if (missing.length > 0) {
          const names = missing.map((r) => `${r.name}#${r.pr}`).join(", ");
          return {
            ...ran,
            context: [
              ...(ran.context ?? []),
              `pr-proof: no proof record for ${names} yet. Write it with the pr-proof:record-proof skill from the checks you ran, before reporting the PR ready.`,
            ],
          };
        }
      }
    } catch {
      // Bookkeeping only: never fail the call over it.
    }
    return ran;
  }).catch(($, e, next) => next(e));
};
