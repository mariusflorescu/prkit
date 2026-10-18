import type { DiffFile, FileReviewState, LinePoint, NormalizedGuide } from "@prkit/contracts";
import type { ReactNode } from "react";

export type DiffAnnotation =
  NormalizedGuide["chapters"][number]["files"][number]["annotations"][number];

export type DiffContents = { oldContents: string; newContents: string };
export type LoadContents = (file: DiffFile) => Promise<DiffContents | null>;

export type ContentsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

/** A run of diff lines from `start` to `end`, the same point for one line. */
export type LineRange = { start: LinePoint; end: LinePoint };

/**
 * Lines to scroll to and highlight; `onCell` gets the first line's number cell once it
 * renders. A null range only opens the file's card, as for a deleted or binary file.
 */
export type RevealLines =
  | { readonly range: LineRange; readonly onCell: (cell: HTMLElement) => void }
  | { readonly range: null };

/** Review comments on one file's diff, opted into by the caller. */
export type DiffComments = {
  /** The lines that have something under them, drawn by `render`. */
  pins: ReadonlyArray<LinePoint>;
  render: (point: LinePoint) => ReactNode;
  /** The lines being commented on, highlighted while the composer is open. */
  selection: LineRange | null;
  /** A click on a line's comment button or a drag across line numbers. */
  onSelect: (range: LineRange) => void;
  /** Shown under the diff, for comments whose lines are no longer in it. */
  footer: ReactNode;
  /** Shown under a guide note's text, by the note's place among the file's notes. */
  noteFooter?: ((note: DiffAnnotation, index: number) => ReactNode) | undefined;
  count: number;
};

/** A file's Reviewed checkbox, opted into by the caller. `onChange` resolves true once saved. */
export type ReviewedControl = {
  state: FileReviewState;
  onChange: (reviewed: boolean) => Promise<boolean>;
};
