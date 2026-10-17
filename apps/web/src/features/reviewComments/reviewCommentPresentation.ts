import type { CommentAnchor, LinePoint } from "@prkit/contracts";

import type { DiffAnnotation } from "~/components/diff";

const side = (point: LinePoint) => (point.side === "old" ? "old " : "");

/** "line 12", "old lines 10 to 14", or "old line 9 to line 11" across sides. */
export const rangeLabel = ({ start, end }: Pick<CommentAnchor, "start" | "end">) =>
  start.side !== end.side
    ? `${side(start)}line ${start.line} to ${side(end)}line ${end.line}`
    : start.line === end.line
      ? `${side(end)}line ${end.line}`
      : `${side(end)}lines ${start.line} to ${end.line}`;

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
