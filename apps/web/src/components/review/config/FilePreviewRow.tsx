import type { FileDecision } from "@prkit/contracts";

import { cn } from "~/lib/utils";

import { PathDecisionLine } from "./PathDecisionLine";

/** One changed file: reviewed or skipped, and why. A rename shows both of its paths. */
export function FilePreviewRow({ decision }: { decision: FileDecision }) {
  const renamed = decision.sides.length > 1;
  return (
    <li
      aria-label={`${decision.path}: ${decision.skipped ? "skipped" : "reviewed"}`}
      className="space-y-0.5 py-1.5"
    >
      <p className={cn("truncate font-mono text-xs", decision.skipped && "text-muted-foreground")}>
        {decision.path}
        {renamed && decision.previousPath !== null && (
          <span className="text-muted-foreground"> (renamed from {decision.previousPath})</span>
        )}
      </p>
      {decision.sides.map((side, index) => (
        <PathDecisionLine
          key={side.path}
          side={side}
          prefix={renamed ? (index === 0 ? "New path" : "Old path") : null}
        />
      ))}
      {renamed && (
        <p className="text-[11px] text-muted-foreground">
          {decision.skipped
            ? "Skipped: both paths are skipped."
            : "Reviewed: a rename is skipped only when both paths are."}
        </p>
      )}
    </li>
  );
}
