import type { ReviewActivity } from "@prkit/contracts";

import { ActivityDetails } from "./ActivityDetails";

/**
 * One line about what the agent is doing, replaced as it changes: its own words
 * (`report_progress`) when it has said something, else its latest tool call.
 */
export function NarrationLine({
  narration,
  fallback,
  activity,
}: {
  narration: string | null;
  fallback: string;
  activity: ReadonlyArray<ReviewActivity>;
}) {
  const latestTool = activity.findLast((line) => line.kind === "tool")?.text;
  const text = narration ?? latestTool ?? fallback;
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
        <p
          role="status"
          aria-live="polite"
          aria-label="What the agent is doing"
          data-narration={narration === null ? "tool" : "agent"}
          className={
            narration === null
              ? "min-w-0 flex-1 text-sm text-muted-foreground"
              : "min-w-0 flex-1 text-sm font-medium text-foreground"
          }
        >
          {text}
        </p>
      </div>
      <div className="mt-1.5 ps-4">
        <ActivityDetails lines={activity} />
      </div>
    </div>
  );
}
