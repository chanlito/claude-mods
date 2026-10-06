/** What one check came to. `skip` is a check that was planned and not run. */
export type Result = "pass" | "fail" | "skip";

/** One claim the agent checked, where, and the files that show it. */
export type Check = {
  claim: string;
  where?: string;
  result: Result;
  /** File names inside the record's folder. */
  evidence: string[];
};

/** One thing that changed on screen, as a before and an after picture. */
export type Change = { title: string; before?: string; after?: string };

/** A `proof.json`, read and checked, with where it was found. */
export type ProofRecord = {
  /** Absolute path of the folder holding the record and its pictures. */
  dir: string;
  /** The folder under the records root, usually the repo's name. */
  repoDir: string;
  /** `owner/name` when the record says so. */
  repo?: string;
  pr: number;
  title?: string;
  url?: string;
  /** Other names the PR is called by in chat, like `app` for `app#541`. */
  aliases: string[];
  checks: Check[];
  changes: Change[];
  notChecked: string[];
};

/** A PR named in a reply: `name#541`, `owner/name#541`, a PR URL or `#541`. */
export type Ref = { name?: string; pr: number };

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * A file the record names, kept only when it stays inside the record's
 * folder: no absolute path, no `..`, nothing but plain name characters.
 */
export function safeName(v: unknown): string | undefined {
  const name = str(v);
  if (!name || name.startsWith("/") || !/^[\w .\-/]+$/.test(name)) return;
  if (name.split("/").some((part) => part === ".." || part === ""))
    return undefined;
  return name;
}

const RESULTS = new Set<Result>(["pass", "fail", "skip"]);

/** Reads a record's text; anything that is not one answers undefined. */
export function parseRecord(
  text: string,
  dir: string,
  repoDir: string,
  pr: number,
): ProofRecord | undefined {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const url = str(raw.url);
  return {
    dir,
    repoDir,
    repo: str(raw.repo),
    pr,
    title: str(raw.title),
    url: url && /^https?:\/\//.test(url) ? url : undefined,
    aliases: list(raw.aliases).map(str).filter((a): a is string => !!a),
    checks: list(raw.checks).flatMap((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const claim = str(o.claim);
      if (!claim) return [];
      const result = RESULTS.has(o.result as Result)
        ? (o.result as Result)
        : "pass";
      return [
        {
          claim,
          where: str(o.where),
          result,
          evidence: list(o.evidence)
            .map(safeName)
            .filter((n): n is string => !!n),
        },
      ];
    }),
    changes: list(raw.changes).flatMap((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const title = str(o.title);
      const before = safeName(o.before);
      const after = safeName(o.after);
      return title && (before || after) ? [{ title, before, after }] : [];
    }),
    notChecked: list(raw.notChecked)
      .map(str)
      .filter((n): n is string => !!n),
  };
}

const URL_REF = /https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g;
const NAMED_REF = /(?<![\w/#.-])(?:[\w.-]+\/)?([A-Za-z][\w.-]*)#(\d+)\b/g;
const BARE_REF = /(?<![\w/#.-])#(\d+)\b/g;

/** Every PR a reply names, each once, in the order they first appear. */
export function findRefs(text: string): Ref[] {
  const found: { at: number; ref: Ref }[] = [];
  for (const m of text.matchAll(URL_REF))
    found.push({ at: m.index ?? 0, ref: { name: m[1], pr: Number(m[2]) } });
  for (const m of text.matchAll(NAMED_REF))
    found.push({ at: m.index ?? 0, ref: { name: m[1], pr: Number(m[2]) } });
  for (const m of text.matchAll(BARE_REF))
    found.push({ at: m.index ?? 0, ref: { pr: Number(m[1]) } });
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.ref)
    .filter((r) => {
      const key = `${r.name ?? ""}#${r.pr}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const nameOf = (r: ProofRecord) => r.repo?.split("/").at(-1);

/**
 * The records a reply's refs point at, each once. A bare `#541` counts only
 * when one record has that number, or one sits under the repo `here` names.
 */
export function resolveRefs(
  refs: Ref[],
  records: ProofRecord[],
  here?: string,
): ProofRecord[] {
  const out: ProofRecord[] = [];
  for (const ref of refs) {
    const same = records.filter((r) => r.pr === ref.pr);
    let hit: ProofRecord | undefined;
    if (ref.name) {
      const name = ref.name;
      hit = same.find(
        (r) =>
          r.repoDir === name || nameOf(r) === name || r.aliases.includes(name),
      );
    } else {
      hit =
        same.length === 1
          ? same[0]
          : same.find((r) => r.repoDir === here || nameOf(r) === here);
    }
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** `web#541`-style label: the repo's name, else its folder. */
export const labelOf = (r: ProofRecord) => `${nameOf(r) ?? r.repoDir}#${r.pr}`;

/** "6 checks · 2 changes · 1 failed · 3 not checked", the parts that apply. */
export function countsOf(r: ProofRecord): string {
  const failed = r.checks.filter((c) => c.result === "fail").length;
  const skipped =
    r.checks.filter((c) => c.result === "skip").length + r.notChecked.length;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    plural(r.checks.length, "check"),
    r.changes.length ? plural(r.changes.length, "change") : "",
    failed ? `${failed} failed` : "",
    skipped ? `${skipped} not checked` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
