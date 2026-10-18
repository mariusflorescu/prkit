import type { PullRequestSize } from "@prkit/contracts";

import { readingTimeLabel } from "./triageCopy";

export function InboxSizeMark({ size }: { size: PullRequestSize }) {
  return (
    <span data-size={size.bucket} className="flex items-center gap-1.5 text-muted-foreground">
      <span className="min-w-5 rounded bg-muted px-1 text-center font-medium text-3xs">
        {size.bucket}
      </span>
      <span className="hidden sm:inline">{readingTimeLabel(size.readingMinutes)}</span>
    </span>
  );
}
