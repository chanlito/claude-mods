/**
 * The YAML a stack file needs, and no more: block maps and lists by
 * indentation, `[a, b]` and `{ k: v }` on one line, quoted and plain scalars,
 * numbers, true/false/null and `#` comments. No anchors, tags, multi-line
 * strings or documents. A mod has no npm packages, so this stands in for one.
 */

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

type Line = { n: number; indent: number; text: string };

export function parseYaml(source: string): unknown {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = stripComment(raw).replace(/\s+$/, "");
    if (!text.trim()) return;
    if (/^ *\t/.test(text)) throw new YamlError("indent with spaces, not tabs", i + 1);
    lines.push({ n: i + 1, indent: text.length - text.trimStart().length, text: text.trim() });
  });
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) throw new YamlError("unexpected indentation", lines[next]!.n);
  return value;
}

const isItem = (text: string) => text === "-" || text.startsWith("- ");

function parseBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  return isItem(lines[i]!.text) ? parseList(lines, i, indent) : parseMap(lines, i, indent);
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:"'[\]{}#,][^:]*?)\s*:(?:\s+(.*))?$/;

function parseMap(lines: Line[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (isItem(line.text)) throw new YamlError("a list item where a key was expected", line.n);
    const m = KEY.exec(line.text);
    if (!m) throw new YamlError(`expected "key: value", found "${line.text}"`, line.n);
    const key = unquote(m[1]!, line.n);
    if (Object.hasOwn(out, key)) throw new YamlError(`"${key}" is given twice`, line.n);
    const rest = m[2];
    i++;
    const below = lines[i];
    if (rest) out[key] = parseInline(rest, line.n);
    else if (below && below.indent > indent) [out[key], i] = parseBlock(lines, i, below.indent);
    else if (below && below.indent === indent && isItem(below.text)) [out[key], i] = parseList(lines, i, indent);
    else out[key] = null;
  }
  if (i < lines.length && lines[i]!.indent > indent) throw new YamlError("unexpected indentation", lines[i]!.n);
  return [out, i];
}

function parseList(lines: Line[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < lines.length && lines[i]!.indent === indent && isItem(lines[i]!.text)) {
    const line = lines[i]!;
    const rest = line.text.slice(1).trimStart();
    if (!rest) {
      i++;
      const below = lines[i];
      if (below && below.indent > indent) {
        let value: unknown;
        [value, i] = parseBlock(lines, i, below.indent);
        out.push(value);
      } else out.push(null);
    } else if (KEY.test(rest)) {
      // `- key: value` opens a map whose keys line up with `key`.
      const column = indent + line.text.length - rest.length;
      lines[i] = { n: line.n, indent: column, text: rest };
      let value: unknown;
      [value, i] = parseMap(lines, i, column);
      out.push(value);
    } else {
      out.push(parseInline(rest, line.n));
      i++;
    }
  }
  return [out, i];
}

type Cursor = { s: string; i: number; n: number };

function parseInline(text: string, n: number): unknown {
  const p: Cursor = { s: text, i: 0, n };
  const value = flowValue(p, false);
  skip(p);
  if (p.i < p.s.length) throw new YamlError(`unexpected "${p.s.slice(p.i)}"`, n);
  return value;
}

function skip(p: Cursor) {
  while (p.s[p.i] === " ") p.i++;
}

function flowValue(p: Cursor, inFlow: boolean): unknown {
  skip(p);
  const c = p.s[p.i];
  if (c === "[") {
    p.i++;
    const list: unknown[] = [];
    skip(p);
    if (p.s[p.i] === "]") return p.i++, list;
    for (;;) {
      list.push(flowValue(p, true));
      skip(p);
      const d = p.s[p.i++];
      if (d === "]") return list;
      if (d !== ",") throw new YamlError('expected "," or "]"', p.n);
    }
  }
  if (c === "{") {
    p.i++;
    const map: Record<string, unknown> = {};
    skip(p);
    if (p.s[p.i] === "}") return p.i++, map;
    for (;;) {
      skip(p);
      const key = flowKey(p);
      skip(p);
      if (p.s[p.i++] !== ":") throw new YamlError(`expected ":" after "${key}"`, p.n);
      map[key] = flowValue(p, true);
      skip(p);
      const d = p.s[p.i++];
      if (d === "}") return map;
      if (d !== ",") throw new YamlError('expected "," or "}"', p.n);
    }
  }
  if (c === '"' || c === "'") return quoted(p);
  let j = p.i;
  while (j < p.s.length && !(inFlow && /[,\]}]/.test(p.s[j]!))) j++;
  const raw = p.s.slice(p.i, j).trim();
  p.i = j;
  return scalar(raw);
}

function flowKey(p: Cursor): string {
  const c = p.s[p.i];
  if (c === '"' || c === "'") return quoted(p);
  const j = p.s.indexOf(":", p.i);
  if (j < 0) throw new YamlError('expected "key: value"', p.n);
  const key = p.s.slice(p.i, j).trim();
  p.i = j;
  return key;
}

function quoted(p: Cursor): string {
  const q = p.s[p.i++];
  let out = "";
  while (p.i < p.s.length) {
    const c = p.s[p.i++]!;
    if (q === "'" && c === "'") {
      if (p.s[p.i] === "'") (out += "'"), p.i++;
      else return out;
    } else if (q === '"' && c === '"') return out;
    else if (q === '"' && c === "\\") {
      const e = p.s[p.i++];
      out += e === "n" ? "\n" : e === "t" ? "\t" : (e ?? "");
    } else out += c;
  }
  throw new YamlError("a quote is not closed", p.n);
}

function unquote(text: string, n: number): string {
  return /^["']/.test(text) ? parseInline(text, n) as string : text.trim();
}

function scalar(raw: string): unknown {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Drops a `#` comment: at the start, or after a space, outside quotes. */
function stripComment(raw: string): string {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,]/.test(raw[i - 1]!))) quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}
