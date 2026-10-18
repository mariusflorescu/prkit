import { CornerDownRight, CornerUpRight } from "lucide-react";

import { useDiffList } from "./diffListContext";
import type { Move, MoveEnd } from "./moves";

const linesOf = (end: MoveEnd) =>
  end.start === end.end ? `line ${end.start}` : `lines ${end.start}-${end.end}`;

/** Above each end of a moved block: where the other end is, as a way there when the list can show it. */
export function MoveChip({ move, end }: { move: Move; end: "cut" | "landed" }) {
  const { goTo, reachable } = useDiffList();
  const other = end === "cut" ? move.to : move.from;
  const sameFile = move.from.path === move.to.path;
  const Icon = end === "cut" ? CornerUpRight : CornerDownRight;
  const where = sameFile ? `line ${other.start}` : other.path;
  const count = `${move.lines} line${move.lines === 1 ? "" : "s"}`;
  const title = [
    `Moved from ${move.from.path} ${linesOf(move.from)} to ${move.to.path} ${linesOf(move.to)}.`,
    move.edited > 0
      ? `${move.edited} line${move.edited === 1 ? "" : "s"} changed on the way.`
      : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
  const label = end === "cut" ? "Moved to" : "Moved from";
  return (
    <div data-move-chip-row="">
      <span data-move-chip="" title={title}>
        <Icon size={12} aria-hidden="true" />
        <span>{label}</span>
        {reachable(other.path) ? (
          <button
            type="button"
            data-move-chip-link=""
            aria-label={`Show ${other.path} ${linesOf(other)}`}
            onClick={() =>
              goTo({
                path: other.path,
                range: {
                  start: { side: other.side, line: other.start },
                  end: { side: other.side, line: other.end },
                },
              })
            }
          >
            {where}
          </button>
        ) : (
          <span data-move-chip-where="">{where}</span>
        )}
        <span data-move-chip-count="">· {count}</span>
      </span>
    </div>
  );
}
