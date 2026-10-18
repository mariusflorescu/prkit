import type { DiffRow, LinePoint, NoteRef } from "@prkit/contracts";

import type { DiffAnnotation } from "~/components/diff";
import type { NoteSurface } from "./reviewCommentsStore";

/**
 * A guide line note where a surface shows it. Its identity (`ref`, and the NoteKey from
 * `written` on `writtenRows`, the diff at `writtenHead`) is the revision's on every surface;
 * `at` and `rows` are the diff on screen at `head`, which on the Guide is the revision's own.
 */
export type ShownNote = {
  readonly on: NoteSurface;
  readonly ref: NoteRef;
  readonly written: DiffAnnotation;
  readonly writtenRows: ReadonlyArray<DiffRow>;
  readonly writtenHead: string;
  readonly at: LinePoint;
  readonly rows: ReadonlyArray<DiffRow>;
  readonly head: string;
};

export const samePoint = (a: LinePoint, b: LinePoint) => a.side === b.side && a.line === b.line;

export const sameRef = (a: NoteRef, b: NoteRef) =>
  a.revision === b.revision && a.path === b.path && a.index === b.index;
