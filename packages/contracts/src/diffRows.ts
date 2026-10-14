import type { CommentAnchor, LinePoint } from "./reviewComments.ts";

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
