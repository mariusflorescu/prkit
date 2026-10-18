import type { DiffFile } from "./diffSnapshot.ts";
import type { NormalizedGuide } from "./guide.ts";
import type { FileSide } from "./pullRequest.ts";
import {
  type CommentContext,
  type CommentPlacement,
  type LinePoint,
  NoteKey,
  type PendingComment,
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
  rows.findIndex((row) => row[point.side] === point.line);

const rowText = (row: DiffRow) => `${row.marker}${row.text}`;

const snippetOf = (rows: ReadonlyArray<DiffRow>) => rows.map(rowText).join("\n");

/** Rows on each side of a comment's rows that must read the same for it to stay put. */
const CONTEXT_ROWS = 3;

/**
 * Up to `count` rows next to `from` in its hunk, walking by `step`, that have a number on
 * `side`, in the order walked.
 */
const neighbours = (
  rows: ReadonlyArray<DiffRow>,
  from: number,
  step: 1 | -1,
  side: FileSide,
  count: number,
) => {
  const hunk = rows[from]?.hunk;
  const found: Array<string> = [];
  for (let at = from + step; found.length < count; at += step) {
    const row = rows[at];
    if (row === undefined || row.hunk !== hunk) break;
    if (row[side] !== null) found.push(rowText(row));
  }
  return found;
};

/** Rows `first` to `last` of one hunk as a placement, each end on its own side. */
const cut = (
  rows: ReadonlyArray<DiffRow>,
  path: string,
  span: { first: number; last: number; start: FileSide; end: FileSide },
  commitSha: string,
): CommentPlacement | null => {
  const start = rows[span.first]?.[span.start] ?? null;
  const end = rows[span.last]?.[span.end] ?? null;
  if (start === null || end === null) return null;
  return {
    anchor: {
      path,
      start: { side: span.start, line: start },
      end: { side: span.end, line: end },
    },
    snippet: snippetOf(rows.slice(span.first, span.last + 1)),
    context: {
      before: neighbours(rows, span.first, -1, span.start, CONTEXT_ROWS).toReversed(),
      after: neighbours(rows, span.last, 1, span.end, CONTEXT_ROWS),
    },
    commitSha,
  };
};

/**
 * The rows between two points, in either order, and the rows around them, as a placement on
 * the diff at `commitSha`. Null when the patch doesn't show both inside one hunk: GitHub only
 * takes comments on such ranges.
 */
export const capture = (
  rows: ReadonlyArray<DiffRow>,
  range: { path: string; start: LinePoint; end: LinePoint },
  commitSha: string,
) => {
  const a = rowIndex(rows, range.start);
  const b = rowIndex(rows, range.end);
  if (a < 0 || b < 0 || rows[a]?.hunk !== rows[b]?.hunk) return null;
  const [start, end] = a <= b ? [range.start, range.end] : [range.end, range.start];
  return cut(
    rows,
    range.path,
    { first: Math.min(a, b), last: Math.max(a, b), start: start.side, end: end.side },
    commitSha,
  );
};

/** A diff at one head: GitHub's files for the PR now, or a guide revision's snapshot. */
export type HeadDiff = {
  headSha: string;
  files: ReadonlyArray<Pick<DiffFile, "path" | "patch">>;
};

/** It can't be sent until a person picks its line. */
export type Outdated = {
  _tag: "outdated";
  /**
   * `file`: no text diff for its file. `lines`: its rows or the rows around them changed, or
   * read the same in more than one place. `unchecked`: written before prkit kept its lines,
   * and this diff isn't one prkit can trust its numbers on.
   */
  why: "file" | "lines" | "unchecked";
  /**
   * Where its own rows alone read the same in exactly one place, for the user to confirm.
   * Captured on this diff.
   */
  suggestion: CommentPlacement | null;
};

/** Where a comment goes on one diff. A kept or moved `placement` is captured on that diff. */
export type Placed =
  /** At its own numbers, with the same rows around it. */
  | { _tag: "kept"; placement: CommentPlacement }
  /** Its rows and the rows around them read the same in exactly one other place. */
  | { _tag: "moved"; placement: CommentPlacement }
  | Outdated;

/** A comment that sits on the diff, at its own numbers or where its lines moved to. */
export type Landed = Exclude<Placed, Outdated>;

const reads = (have: ReadonlyArray<string>, want: ReadonlyArray<string>) =>
  have.length === want.length && have.every((line, index) => line === want[index]);

/**
 * Every row where the comment's own rows start, inside one hunk, with each end on its side.
 * With `context`, the rows around them on those sides must read it too. A comment recorded
 * with nothing around it must have nothing around it here either, or a lone `+}` would be
 * placed by its numbers alone.
 */
const starts = (
  rows: ReadonlyArray<DiffRow>,
  own: ReadonlyArray<string>,
  sides: { start: FileSide; end: FileSide },
  context: CommentContext | null,
) =>
  rows.flatMap((first, index) => {
    const last = index + own.length - 1;
    const slice = rows.slice(index, last + 1);
    if (
      slice.length !== own.length ||
      slice.at(-1)?.hunk !== first.hunk ||
      first[sides.start] === null ||
      slice.at(-1)?.[sides.end] === null ||
      !reads(slice.map(rowText), own)
    )
      return [];
    if (context === null) return [index];
    const { before, after } = context;
    const alone = before.length === 0 && after.length === 0;
    const above = neighbours(rows, index, -1, sides.start, alone ? 1 : before.length).toReversed();
    const below = neighbours(rows, last, 1, sides.end, alone ? 1 : after.length);
    return reads(above, before) && reads(below, after) ? [index] : [];
  });

/**
 * Where a comment written on one diff goes on `diff`, and whether a person has to decide.
 * Its rows and the rows around them must read the same: at its own numbers it is kept,
 * otherwise in exactly one place it moved there, otherwise it is outdated. A comment written
 * before prkit kept the rows around it is kept only on the head it was written on, where
 * its new-side numbers are the very lines the user picked.
 */
export const place = (
  written: Pick<PendingComment, "anchor" | "snippet" | "context" | "commitSha">,
  diff: HeadDiff,
): Placed => {
  const { anchor, snippet, context } = written;
  const file = diff.files.find((candidate) => candidate.path === anchor.path);
  const rows = file?.patch._tag === "text" ? diffRows(file.patch.patch) : [];
  if (rows.length === 0) return { _tag: "outdated", why: "file", suggestion: null };
  const own = snippet.split("\n");
  const sides = { start: anchor.start.side, end: anchor.end.side };
  const at = (first: number) =>
    cut(rows, anchor.path, { first, last: first + own.length - 1, ...sides }, diff.headSha);
  const only = (found: ReadonlyArray<number>) => {
    const [first] = found;
    return found.length === 1 && first !== undefined ? at(first) : null;
  };
  const outdated = (why: Outdated["why"]): Placed => ({
    _tag: "outdated",
    why,
    suggestion: only(starts(rows, own, sides, null)),
  });
  if (context === null) {
    // The base can move under the same head, so only new-side numbers name the same line.
    const here = capture(rows, anchor, diff.headSha);
    return written.commitSha === diff.headSha &&
      sides.start === "new" &&
      sides.end === "new" &&
      here?.snippet === snippet
      ? { _tag: "kept", placement: here }
      : outdated("unchecked");
  }
  const found = starts(rows, own, sides, context);
  const kept = found.find(
    (first) =>
      rows[first]?.[sides.start] === anchor.start.line &&
      rows[first + own.length - 1]?.[sides.end] === anchor.end.line,
  );
  const keptAt = kept === undefined ? null : at(kept);
  if (keptAt !== null) return { _tag: "kept", placement: keptAt };
  const movedTo = only(found);
  return movedTo === null ? outdated("lines") : { _tag: "moved", placement: movedTo };
};

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

const NOTE_LINES_CHANGED = {
  title: "This line changed after the guide was written",
  description: "prkit won't guess where the comment goes. Comment on the latest code in Files.",
};

/**
 * Why a note can't land in GitHub's diff now, as the user reads it. A note is always
 * captured with the rows around it, so `unchecked` only completes the record.
 */
export const NOTE_LOST = {
  file: {
    title: "GitHub shows no diff for this file now",
    description: "prkit can only place a comment on a line GitHub shows in the diff.",
  },
  lines: NOTE_LINES_CHANGED,
  unchecked: NOTE_LINES_CHANGED,
} as const satisfies Record<Outdated["why"], { title: string; description: string }>;
