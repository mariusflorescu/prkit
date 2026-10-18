import { useId } from "react";

import type { PseudocodeRow } from "@prkit/contracts";

import { keyedItems } from "./keyedItems";

const marks = {
  added: { marker: "+", spoken: "Added: " },
  removed: { marker: "-", spoken: "Removed: " },
  unchanged: { marker: "", spoken: "" },
} as const;

/** One side of a chapter's pseudocode pair. A null line is a filler that only keeps the sides aligned. */
export function PseudocodeSide({
  side,
  label,
  lines,
}: {
  side: "before" | "after";
  label: string;
  lines: ReadonlyArray<PseudocodeRow["before"] | PseudocodeRow["after"]>;
}) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-pseudocode-side={side}
      style={{ gridRow: `1 / span ${lines.length + 1}` }}
    >
      <span id={labelId} data-pseudocode-label="">
        {label}
      </span>
      <ol style={{ gridRow: `2 / span ${lines.length}` }}>
        {keyedItems(lines, (line) => (line === null ? "" : `${line.status}:${line.text}`)).map(
          ({ key, value: line }) => {
            if (line === null) return <li key={key} data-pseudocode-filler="" aria-hidden="true" />;
            const mark = marks[line.status];
            return (
              <li key={key} data-pseudocode-line="" data-status={line.status}>
                <span data-pseudocode-marker="" aria-hidden="true">
                  {mark.marker}
                </span>
                <span data-pseudocode-text="">
                  {mark.spoken && <span className="sr-only">{mark.spoken}</span>}
                  {line.text}
                </span>
              </li>
            );
          },
        )}
      </ol>
    </div>
  );
}
