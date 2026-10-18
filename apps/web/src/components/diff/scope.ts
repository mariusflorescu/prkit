import type { DiffFile, DiffRow, LinePoint } from "@prkit/contracts";

import { fileRows } from "./fileDiff";

export type ScopeLine = { readonly line: number; readonly text: string };
/** One per hunk: where it starts on the new side, and every opener above its first change. */
export type HunkScope = {
  readonly newStart: number;
  readonly chain: ReadonlyArray<ScopeLine>;
};

const indentOf = (text: string) => {
  let indent = 0;
  for (const char of text) {
    if (char === " ") indent++;
    else if (char === "\t") indent += 4;
    else break;
  }
  return indent;
};
const isComment = (text: string) => /^(\/\/|\/\*|\*|#(?![[!])|--|<!--|"""|''')/.test(text);
const CONTINUES = /^[\])}]+\s*(else|catch|finally|elif|except|while)\b/;
/**
 * A closing bracket that ends a header spread over several lines, not a block's end, or a
 * brace on a line of its own under its header (Allman style).
 */
const isHeaderTail = (text: string) =>
  text === "{" || (/^([\])}>]|\/>)/.test(text) && !CONTINUES.test(text));

/**
 * The openers enclosing the 0-based line `from`, outermost first: each line above it that
 * is indented less than everything below it so far.
 */
const scopeChain = (lines: ReadonlyArray<string>, from: number, indent: number) => {
  const chain: Array<ScopeLine> = [];
  let limit = indent;
  let at = from - 1;
  while (at >= 0 && limit > 0) {
    const raw = lines[at] ?? "";
    const text = raw.trim();
    const own = indentOf(raw);
    if (text === "" || own >= limit || isComment(text)) {
      at--;
      continue;
    }
    if (isHeaderTail(text)) {
      let head = at - 1;
      while (head >= 0) {
        const line = lines[head] ?? "";
        const trimmed = line.trim();
        if (
          trimmed !== "" &&
          indentOf(line) <= own &&
          !isHeaderTail(trimmed) &&
          !isComment(trimmed)
        )
          break;
        head--;
      }
      if (head < 0) break;
      const header = lines[head] ?? "";
      chain.push({ line: head + 1, text: header });
      limit = indentOf(header);
      at = head - 1;
      continue;
    }
    chain.push({ line: at + 1, text: raw });
    limit = own;
    at--;
  }
  return chain.toReversed();
};

const hunksOf = (rows: ReadonlyArray<DiffRow>) => {
  const hunks: Array<Array<DiffRow>> = [];
  for (const row of rows) {
    const hunk = hunks[row.hunk];
    if (hunk) hunk.push(row);
    else hunks[row.hunk] = [row];
  }
  return hunks.filter((hunk) => hunk.length > 0);
};

const startOf = (hunk: ReadonlyArray<DiffRow>, side: LinePoint["side"]) =>
  hunk.find((row) => (side === "old" ? row.old : row.new) !== null)?.[side] ?? 0;

/** Where to walk up from in the new file, and the indent of the hunk's first changed code. */
const target = (hunk: ReadonlyArray<DiffRow>) => {
  let line = startOf(hunk, "new");
  for (const [at, row] of hunk.entries()) {
    if (row.marker === " ") {
      line++;
      continue;
    }
    let first = at;
    while (
      hunk[first] !== undefined &&
      hunk[first]?.marker !== " " &&
      hunk[first]?.text.trim() === ""
    )
      first++;
    const pick = hunk[first] ?? row;
    if (pick.marker === " " || pick.text.trim() === "") return null;
    return { from: line - 1, indent: indentOf(pick.text) };
  }
  return null;
};

/** Files whose hunks can float: changed in place, with lines hidden above some hunk. */
export const needsText = (file: DiffFile) =>
  file.patch._tag === "text" &&
  (file.status === "modified" || file.status === "renamed") &&
  hunksOf(fileRows(file)).some((hunk) => startOf(hunk, "new") > 1);

const scoped = new WeakMap<DiffFile, { text: string; scopes: ReadonlyArray<HunkScope> }>();

/** `hunkScopes`, worked out once per file and text, so asking again returns the same chains. */
export function fileScopes(file: DiffFile, newText: string) {
  const known = scoped.get(file);
  if (known?.text === newText) return known.scopes;
  const scopes = hunkScopes(file, newText);
  scoped.set(file, { text: newText, scopes });
  return scopes;
}

export function hunkScopes(file: DiffFile, newText: string): ReadonlyArray<HunkScope> {
  const lines = newText.split("\n");
  return hunksOf(fileRows(file)).map((hunk) => {
    const at = target(hunk);
    return {
      newStart: startOf(hunk, "new"),
      chain: at === null ? [] : scopeChain(lines, at.from, at.indent),
    };
  });
}

/**
 * The openers hidden above a separator, given the first new line shown below it and the new
 * lines shown just above it. The hunk is the first that starts at or after `firstShown`, since
 * expanding only reveals lines above a hunk; an opener at or below `firstShown`, or among the
 * lines shown above, is already on the page.
 */
export function hiddenScope(
  scopes: ReadonlyArray<HunkScope>,
  firstShown: number,
  shownAbove: ReadonlySet<number>,
) {
  const hunk = scopes.find((scope) => scope.newStart >= firstShown);
  return (hunk?.chain ?? []).filter(
    (opener) => opener.line < firstShown && !shownAbove.has(opener.line),
  );
}

const MAX_OPENER = 80;
const tidy = (text: string) => {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > MAX_OPENER ? `${line.slice(0, MAX_OPENER - 1)}…` : line;
};

/** Up to three openers as they read; deeper chains keep the outermost and the last two. */
export function scopeLabel(chain: ReadonlyArray<ScopeLine>) {
  const outer = chain[0];
  const parts =
    chain.length <= 3 || outer === undefined
      ? chain.map((opener) => tidy(opener.text))
      : [tidy(outer.text), "…", ...chain.slice(-2).map((opener) => tidy(opener.text))];
  return {
    parts,
    text: parts.join(" › "),
    title: chain
      .map((opener) => `${opener.line}: ${opener.text.trim().replace(/\s+/g, " ")}`)
      .join("\n"),
  };
}
