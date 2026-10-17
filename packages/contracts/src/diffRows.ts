import type { NormalizedGuide } from "./guide.ts";
import type { PullRequestFiles } from "./pullRequest.ts";
import {
  type CommentAnchor,
  type CommentPlacement,
  type LinePoint,
  NoteKey,
} from "./reviewComments.ts";

/** One row of a unified diff with the numbers GitHub uses for each side. */
export type DiffRow = {
  hunk: number;
  marker: " " | "+" | "-";
  old: number | null;
  new: number | null;
  text: string;
};

/** The rows of a patch's hunks. Header lines before the first hunk are skipped. */
export const diffRows = (patch: string) => {
  const rows: Array<DiffRow> = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    if (oldLeft === 0 && newLeft === 0) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header === null) continue;
      hunk++;
      oldLine = Number(header[1]);
      oldLeft = Number(header[2] ?? 1);
      newLine = Number(header[3]);
      newLeft = Number(header[4] ?? 1);
      continue;
    }
    const marker = line.charAt(0);
    const text = line.slice(1);
    if (marker === "+") {
      rows.push({ hunk, marker, old: null, new: newLine++, text });
      newLeft--;
    } else if (marker === "-") {
      rows.push({ hunk, marker, old: oldLine++, new: null, text });
      oldLeft--;
    } else if (marker === " " || line === "") {
      rows.push({ hunk, marker: " ", old: oldLine++, new: newLine++, text });
      oldLeft--;
      newLeft--;
    }
  }
  return rows;
};

const rowIndex = (rows: ReadonlyArray<DiffRow>, point: LinePoint) =>
  rows.findIndex((row) => (point.side === "old" ? row.old : row.new) === point.line);

const snippetOf = (rows: ReadonlyArray<DiffRow>) =>
  rows.map((row) => `${row.marker}${row.text}`).join("\n");

/**
 * The diff rows between two points, in diff order, or null when the patch doesn't
 * show both inside one hunk. GitHub only takes comments on such ranges.
 */
export const rangeRows = (rows: ReadonlyArray<DiffRow>, a: LinePoint, b: LinePoint) => {
  const first = rowIndex(rows, a);
  const last = rowIndex(rows, b);
  if (first < 0 || last < 0) return null;
  const [start, end] = first <= last ? [a, b] : [b, a];
  const slice = rows.slice(Math.min(first, last), Math.max(first, last) + 1);
  if (slice[0]?.hunk !== slice.at(-1)?.hunk) return null;
  return { start, end, snippet: snippetOf(slice) };
};

/** Whether a comment written on `snippet` still sits on the same lines of this patch. */
export const anchorHolds = (rows: ReadonlyArray<DiffRow>, anchor: CommentAnchor, snippet: string) =>
  rangeRows(rows, anchor.start, anchor.end)?.snippet === snippet;

const pointOf = (row: DiffRow): LinePoint =>
  row.new === null ? { side: "old", line: row.old ?? 0 } : { side: "new", line: row.new };

/** Where a snippet sits in this patch now, when it appears exactly once inside one hunk. */
export const findSnippet = (rows: ReadonlyArray<DiffRow>, path: string, snippet: string) => {
  const length = snippet.split("\n").length;
  let found: CommentAnchor | null = null;
  for (let start = 0; start + length <= rows.length; start++) {
    const slice = rows.slice(start, start + length);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last || first.hunk !== last.hunk || snippetOf(slice) !== snippet) continue;
    if (found !== null) return null;
    found = { path, start: pointOf(first), end: pointOf(last) };
  }
  return found;
};

/** A line note as a guide revision stores it. */
type LineNote = NormalizedGuide["chapters"][number]["files"][number]["annotations"][number];

/** A note's line as a comment point: `additions` is GitHub's new side, `deletions` its old. */
export const notePoint = (note: Pick<LineNote, "side" | "line">): LinePoint => ({
  side: note.side === "additions" ? "new" : "old",
  line: note.line,
});

/** The note's identity, or null when its row isn't in `rows`; a stored note's row always is. */
export const noteKey = (
  path: string,
  rows: ReadonlyArray<DiffRow>,
  note: Pick<LineNote, "side" | "line" | "text">,
) => {
  const row = rows[rowIndex(rows, notePoint(note))];
  return row === undefined
    ? null
    : NoteKey.make(JSON.stringify([path, note.side, snippetOf([row]), note.text]));
};

/** Rows on each side of a note's row that must read the same for the note to land. */
const CONTEXT_ROWS = 3;

export type NotePlacement =
  | { _tag: "placed"; placement: CommentPlacement; moved: boolean }
  /** `file`: GitHub shows no text diff for it now. `lines`: its code changed, or reads the same in two places. */
  | { _tag: "lost"; reason: "file" | "lines" };

/**
 * Where a note written on one diff goes in GitHub's diff now, or why it can't go anywhere.
 * The note's row and up to three rows on each side of it, inside its hunk, must read the
 * same, at the note's own numbers first, otherwise in exactly one place. The side stays
 * the note's, so a note on an old line of context stays on the old side.
 */
export const placeNote = (input: {
  path: string;
  point: LinePoint;
  /** The rows of the diff the note was written on. */
  written: ReadonlyArray<DiffRow>;
  /** GitHub's files at the PR's head now. */
  files: PullRequestFiles;
}): NotePlacement => {
  const { path, point, written, files } = input;
  const lost = (reason: "file" | "lines"): NotePlacement => ({ _tag: "lost", reason });
  const file = files.files.find((candidate) => candidate.path === path);
  const current = file?.patch._tag === "text" ? diffRows(file.patch.patch) : [];
  if (current.length === 0) return lost("file");
  const at = rowIndex(written, point);
  const hunk = written[at]?.hunk;
  if (hunk === undefined) return lost("lines");
  let from = at;
  while (at - from < CONTEXT_ROWS && written[from - 1]?.hunk === hunk) from--;
  let to = at;
  while (to - at < CONTEXT_ROWS && written[to + 1]?.hunk === hunk) to++;
  const window = written.slice(from, to + 1);
  const text = snippetOf(window);
  const offset = at - from;
  const readsAt = (start: number) => {
    if (start < 0) return false;
    const slice = current.slice(start, start + window.length);
    return (
      slice.length === window.length &&
      slice[0]?.hunk === slice.at(-1)?.hunk &&
      snippetOf(slice) === text
    );
  };
  const land = (start: number) => {
    const target = current[start + offset];
    const line = target === undefined ? null : point.side === "new" ? target.new : target.old;
    if (target === undefined || line === null) return lost("lines");
    const lands = { side: point.side, line };
    return {
      _tag: "placed",
      placement: {
        anchor: { path, start: lands, end: lands },
        snippet: snippetOf([target]),
        commitSha: files.headSha,
      },
      moved: line !== point.line,
    } satisfies NotePlacement;
  };
  const here = rowIndex(current, point);
  if (here >= 0 && readsAt(here - offset)) return land(here - offset);
  const elsewhere = current.flatMap((_, start) => (readsAt(start) ? [start] : []));
  const [only] = elsewhere;
  return elsewhere.length === 1 && only !== undefined ? land(only) : lost("lines");
};
