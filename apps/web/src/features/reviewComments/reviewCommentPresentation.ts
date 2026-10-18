import type { CommentAnchor, LinePoint, Outdated } from "@prkit/contracts";

import type { DiffAnnotation } from "~/components/diff";

const side = (point: LinePoint) => (point.side === "old" ? "old " : "");

/** "line 12", "old lines 10 to 14", or "old line 9 to line 11" across sides. */
export const rangeLabel = ({ start, end }: Pick<CommentAnchor, "start" | "end">) =>
  start.side !== end.side
    ? `${side(start)}line ${start.line} to ${side(end)}line ${end.line}`
    : start.line === end.line
      ? `${side(end)}line ${end.line}`
      : `${side(end)}lines ${start.line} to ${end.line}`;

const samePoint = (a: LinePoint, b: LinePoint) => a.side === b.side && a.line === b.line;

/** The offer on an outdated draft: its own line again, or the one place its rows moved to. */
export const suggestionLabel = (written: CommentAnchor, suggestion: CommentAnchor) =>
  `${
    samePoint(written.start, suggestion.start) && samePoint(written.end, suggestion.end)
      ? "Keep on"
      : "Move to"
  } ${rangeLabel(suggestion)}`;

/** Why an outdated draft waits, as its card says it. */
export const OUTDATED_WHY = {
  lines:
    "These lines changed after you wrote this, so it won't be sent until it is on a current line.",
  unchecked:
    "This was written before prkit kept the lines around a comment, and new commits came in since. It won't be sent until you confirm its line.",
  file: "GitHub shows no diff for this file now, so it won't be sent.",
} as const satisfies Record<Outdated["why"], string>;

/** Which guide notes speak to the author. A plain note explains the change to the reviewer. */
export const COMMENTABLE = { question: true, risk: true, note: false } as const satisfies Record<
  DiffAnnotation["tone"],
  boolean
>;

/** The last few lines of a hunk, which is where a thread's line sits. */
export const hunkTail = (diffHunk: string, lines = 4) =>
  diffHunk
    .split("\n")
    .filter((line) => !line.startsWith("@@"))
    .slice(-lines)
    .join("\n");
