import type { DiffFile, DiffRow, LinePoint } from "@prkit/contracts";

import { fileRows } from "./fileDiff";

/** Lines `start..end` of one side of one file, both inclusive. */
export type MoveEnd = {
  readonly path: string;
  readonly side: LinePoint["side"];
  readonly start: number;
  readonly end: number;
};
export type Move = {
  readonly id: number;
  /** Side "old": where the block was cut. */
  readonly from: MoveEnd;
  /** Side "new": where it landed. */
  readonly to: MoveEnd;
  /** How long the block is where it landed. */
  readonly lines: number;
  /** Lines inside the block that changed on the way. */
  readonly edited: number;
};
export type FileMoves = {
  readonly cut: ReadonlyArray<Move>;
  readonly landed: ReadonlyArray<Move>;
  /** The quiet lines, by side. Edited lines are absent, so they keep their color. */
  readonly quiet: { readonly old: ReadonlySet<number>; readonly new: ReadonlySet<number> };
};

export const noMoves: FileMoves = {
  cut: [],
  landed: [],
  quiet: { old: new Set(), new: new Set() },
};

// Like git's --color-moved=blocks with whitespace ignored, with thresholds measured on
// real refactors: seeds need some code in them, a block or a merged move must weigh
// enough to be more than a coincidence, and a move inside one file must jump.
const SEED = 4;
const BLOCK = 20;
const MAX_CANDIDATES = 32;
const GAP = 3;
const MIN_LINES = 3;
const MIN_WEIGHT = 40;
const MIN_JUMP = 3;

/** `key` drops all whitespace, to find moves; `text` keeps what's inside the line, to quiet it. */
type Changed = { line: number; key: string; text: string; weight: number; run: number };
/** A deleted line, with the new-side line it sits before. */
type Cut = Changed & { anchor: number };
type Sides = { old: ReadonlyArray<Cut>; new: ReadonlyArray<Changed> };

const changedLines = (rows: ReadonlyArray<DiffRow>): Sides => {
  const old: Array<Cut> = [];
  const added: Array<Changed> = [];
  let hunk = -1;
  let run = 0;
  let inRun = false;
  let lastNew: number | null = null;
  let pending: Array<Cut> = [];
  const settle = (anchor: number) => {
    for (const cut of pending) cut.anchor = anchor;
    pending = [];
  };
  for (const row of rows) {
    if (row.hunk !== hunk) {
      settle(lastNew === null ? 0 : lastNew + 1);
      hunk = row.hunk;
      inRun = false;
      lastNew = null;
    }
    if (row.new !== null) {
      settle(row.new);
      lastNew = row.new;
    }
    if (row.marker === " ") {
      inRun = false;
      continue;
    }
    if (!inRun) run++;
    inRun = true;
    const key = row.text.replace(/\s+/g, "");
    const weight = key.match(/[A-Za-z0-9_]/g)?.length ?? 0;
    const text = row.text.trim();
    if (row.new !== null) added.push({ line: row.new, key, text, weight, run });
    else if (row.old !== null) {
      const cut = { line: row.old, key, text, weight, run, anchor: 0 };
      old.push(cut);
      pending.push(cut);
    }
  }
  settle(lastNew === null ? 0 : lastNew + 1);
  return { old, new: added };
};

type Block = { from: number; fromStart: number; to: number; toStart: number; length: number };
type Found = {
  from: number;
  to: number;
  oldLines: Array<number>;
  newLines: Array<number>;
};

const detectMoves = (files: ReadonlyArray<Sides>) => {
  const index = new Map<string, Array<readonly [number, number]>>();
  files.forEach((file, fi) =>
    file.old.forEach((cut, di) => {
      if (cut.weight < SEED) return;
      const list = index.get(cut.key);
      if (list) list.push([fi, di]);
      else index.set(cut.key, [[fi, di]]);
    }),
  );
  const claimedOld = files.map((file) => new Uint8Array(file.old.length));
  const blocks: Array<Block> = [];
  files.forEach((file, ti) => {
    const added = file.new;
    const claimedNew = new Uint8Array(added.length);
    for (let i = 0; i < added.length; i++) {
      const a = added[i];
      if (a === undefined || claimedNew[i] || a.weight < SEED) continue;
      const candidates = index.get(a.key);
      if (!candidates || candidates.length > MAX_CANDIDATES) continue;
      let best: { fi: number; di: number; back: number; length: number; weight: number } | null =
        null;
      for (const [fi, di] of candidates) {
        const cuts = files[fi]?.old;
        const claimed = claimedOld[fi];
        const d = cuts?.[di];
        if (!cuts || !claimed || !d || claimed[di]) continue;
        // In place: the same change run of the same file is an edit, not a move.
        if (fi === ti && d.run === a.run) continue;
        let length = 0;
        let weight = 0;
        for (;;) {
          const next = added[i + length];
          const cut = cuts[di + length];
          if (
            !next ||
            !cut ||
            claimedNew[i + length] ||
            claimed[di + length] ||
            next.key !== cut.key ||
            cut.line - d.line !== length ||
            next.line - a.line !== length
          )
            break;
          weight += cut.weight;
          length++;
        }
        let back = 0;
        for (;;) {
          const previous = added[i - back - 1];
          const cut = cuts[di - back - 1];
          if (
            !previous ||
            !cut ||
            claimedNew[i - back - 1] ||
            claimed[di - back - 1] ||
            previous.key !== cut.key ||
            d.line - cut.line !== back + 1 ||
            a.line - previous.line !== back + 1
          )
            break;
          weight += cut.weight;
          back++;
        }
        if (!best || weight > best.weight) best = { fi, di, back, length, weight };
      }
      const claimed = best && claimedOld[best.fi];
      if (!best || !claimed || best.weight < BLOCK) continue;
      const start = i - best.back;
      const fromStart = best.di - best.back;
      const length = best.back + best.length;
      claimedNew.fill(1, start, start + length);
      claimed.fill(1, fromStart, fromStart + length);
      blocks.push({ from: best.fi, fromStart, to: ti, toStart: start, length });
      i = start + length - 1;
    }
  });
  blocks.sort((x, y) => x.to - y.to || x.from - y.from || x.toStart - y.toStart);

  const found: Array<Found> = [];
  let current: Found | null = null;
  let last: Block | null = null;
  for (const block of blocks) {
    const oldLines = (files[block.from]?.old ?? [])
      .slice(block.fromStart, block.fromStart + block.length)
      .map((cut) => cut.line);
    const newLines = (files[block.to]?.new ?? [])
      .slice(block.toStart, block.toStart + block.length)
      .map((line) => line.line);
    const firstOld = oldLines[0] ?? 0;
    const firstNew = newLines[0] ?? 0;
    const oldEnd = current?.oldLines.at(-1) ?? 0;
    const newEnd = current?.newLines.at(-1) ?? 0;
    if (
      current &&
      last &&
      last.to === block.to &&
      last.from === block.from &&
      firstOld > oldEnd &&
      firstOld - oldEnd <= GAP + 1 &&
      firstNew - newEnd <= GAP + 1
    ) {
      current.oldLines.push(...oldLines);
      current.newLines.push(...newLines);
    } else {
      current = { from: block.from, to: block.to, oldLines, newLines };
      found.push(current);
    }
    last = block;
  }

  const lookups = files.map((file) => ({
    old: new Map(file.old.map((cut) => [cut.line, cut])),
    new: new Map(file.new.map((line) => [line.line, line])),
  }));
  return found.filter((move) => {
    const cuts = lookups[move.from]?.old;
    const lands = lookups[move.to]?.new;
    if (!cuts || !lands) return false;
    const blank = (at: number) =>
      cuts.get(move.oldLines[at] ?? 0)?.key === "" && lands.get(move.newLines[at] ?? 0)?.key === "";
    while (move.oldLines.length > 0 && blank(0)) {
      move.oldLines.shift();
      move.newLines.shift();
    }
    while (move.oldLines.length > 0 && blank(move.oldLines.length - 1)) {
      move.oldLines.pop();
      move.newLines.pop();
    }
    const fromStart = move.oldLines[0];
    const toStart = move.newLines[0];
    const toEnd = move.newLines.at(-1);
    if (fromStart === undefined || toStart === undefined || toEnd === undefined) return false;
    if (move.from === move.to) {
      const anchor = cuts.get(fromStart)?.anchor ?? 0;
      const jumped = toStart >= anchor ? toStart - anchor : anchor - (toEnd + 1);
      if (jumped < MIN_JUMP) return false;
    }
    const kept = move.oldLines.flatMap((line) => cuts.get(line) ?? []);
    const weight = kept.reduce((sum, cut) => sum + cut.weight, 0);
    return kept.filter((cut) => cut.key !== "").length >= MIN_LINES && weight >= MIN_WEIGHT;
  });
};

type Span = { start: number; end: number };
const span = (lines: ReadonlyArray<number>): Span => ({
  start: lines[0] ?? 0,
  end: lines.at(-1) ?? 0,
});

type Building = {
  cut: Array<Move>;
  landed: Array<Move>;
  quiet: { old: Set<number>; new: Set<number> };
};

const indexes = new WeakMap<ReadonlyArray<DiffFile>, ReadonlyMap<string, FileMoves>>();

/**
 * The blocks this diff moved, across its files and inside each one, by path. Built once
 * per files array, so a list remounted with the same array costs nothing.
 */
export function movesOf(files: ReadonlyArray<DiffFile>): ReadonlyMap<string, FileMoves> {
  const known = indexes.get(files);
  if (known) return known;
  const sides = files.map((file) => changedLines(fileRows(file)));
  const byPath = new Map<string, Building>();
  const entry = (path: string) => {
    let building = byPath.get(path);
    if (!building) {
      building = { cut: [], landed: [], quiet: { old: new Set(), new: new Set() } };
      byPath.set(path, building);
    }
    return building;
  };
  detectMoves(sides).forEach((found, id) => {
    const from = files[found.from];
    const to = files[found.to];
    const fromSide = sides[found.from];
    const toSide = sides[found.to];
    if (!from || !to || !fromSide || !toSide) return;
    const oldSpan = span(found.oldLines);
    const newSpan = span(found.newLines);
    // Spacing inside a line can be the change itself (a string literal), so only a line that
    // reads the same once its indentation is set aside goes quiet; the rest count as edited.
    const oldText = new Map(fromSide.old.map((line) => [line.line, line.text]));
    const newText = new Map(toSide.new.map((line) => [line.line, line.text]));
    const same = found.oldLines.flatMap((line, index) => {
      const landedAt = found.newLines[index];
      return landedAt !== undefined && oldText.get(line) === newText.get(landedAt)
        ? [[line, landedAt] as const]
        : [];
    });
    const matchedOld = new Set(same.map(([line]) => line));
    const matchedNew = new Set(same.map(([, line]) => line));
    const unmatched = (lines: ReadonlyArray<Changed>, range: Span, matched: ReadonlySet<number>) =>
      lines.filter(
        (line) => line.line >= range.start && line.line <= range.end && !matched.has(line.line),
      ).length;
    const move: Move = {
      id,
      from: { path: from.path, side: "old", ...oldSpan },
      to: { path: to.path, side: "new", ...newSpan },
      lines: newSpan.end - newSpan.start + 1,
      edited: Math.max(
        unmatched(fromSide.old, oldSpan, matchedOld),
        unmatched(toSide.new, newSpan, matchedNew),
      ),
    };
    const cut = entry(from.path);
    cut.cut.push(move);
    for (const line of matchedOld) cut.quiet.old.add(line);
    const landed = entry(to.path);
    landed.landed.push(move);
    for (const line of matchedNew) landed.quiet.new.add(line);
  });
  indexes.set(files, byPath);
  return byPath;
}

/**
 * The line a chip above a block hangs under: the row right above the block's first line
 * that shows on the chip's side (context, or a changed line of that side), with that
 * side's number. A block that opens its hunk, as in a patch without context, takes the
 * slot above the file when it starts the file, and its own first line otherwise.
 */
export function chipLine(rows: ReadonlyArray<DiffRow>, end: MoveEnd) {
  const numberOf = (row: DiffRow) => (end.side === "old" ? row.old : row.new);
  const at = rows.findIndex((row) => numberOf(row) === end.start);
  const hunk = rows[at]?.hunk;
  for (let index = at - 1; index >= 0; index--) {
    const row = rows[index];
    if (row === undefined || row.hunk !== hunk) break;
    const line = numberOf(row);
    if (line !== null) return line;
  }
  return end.start === 1 ? 0 : end.start;
}
