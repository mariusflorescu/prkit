import type { PullRequestSize } from "@prkit/contracts";

import { cn } from "~/lib/utils";

import { InboxSizeMark } from "./InboxSizeMark";
import type { RowClock } from "./inboxPresentation";

export function InboxTriage({
  size,
  clock,
  fades,
}: {
  size: PullRequestSize;
  clock: RowClock;
  fades: boolean;
}) {
  return (
    <span
      className={cn(
        "flex w-36 flex-col items-end pl-2 text-2xs tabular-nums",
        fades &&
          "transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none",
      )}
    >
      <span className="flex h-5 items-center">
        <InboxSizeMark size={size} />
      </span>
      <time
        dateTime={clock.at}
        data-clock
        className="mt-0.5 flex min-h-3.5 max-w-full items-center truncate whitespace-nowrap text-muted-foreground"
      >
        {clock.label}
      </time>
    </span>
  );
}
