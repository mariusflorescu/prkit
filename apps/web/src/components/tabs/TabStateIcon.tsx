import type { InboxEntry, ReviewSnapshot } from "@prkit/contracts";
import { CheckIcon } from "lucide-react";
import { guideProgress } from "~/components/review/progressModel";
import { pullRequestState } from "~/lib/pullRequestState";
import { cn } from "~/lib/utils";
import { TabProgressRing } from "./TabProgressRing";

export function TabStateIcon({
  data,
  review,
  conflicting = false,
}: {
  data: Pick<InboxEntry, "state" | "isDraft"> | undefined;
  review: ReviewSnapshot | undefined;
  /** The branch conflicts with its base: the same warning dot as a failed guide. */
  conflicting?: boolean;
}) {
  const status = review?.review?.status._tag;
  const running = status === "preparing" || status === "writing";
  // Static: the ring fills only when a file is read or a chapter is written.
  const filled =
    running && review?.attempt != null
      ? Math.round(guideProgress(review.attempt).fraction * 100)
      : 0;
  // No data yet (the PR was only just opened): the neutral open look.
  const { Icon, tone } = pullRequestState(data ?? { state: "open", isDraft: false });
  return (
    <span
      aria-hidden="true"
      data-review-status={status ?? "none"}
      className="relative flex size-3 items-center justify-center"
    >
      {running ? <TabProgressRing filled={filled} /> : <Icon className={cn("size-3", tone)} />}
      {(status === "failed" || conflicting) && (
        <span
          data-guide-warning=""
          data-conflicting={conflicting || undefined}
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-warning-foreground"
        />
      )}
      {status === "watching" && !conflicting && (
        <span
          data-guide-watching=""
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-success-foreground"
        />
      )}
      {status === "done" && (
        <CheckIcon
          data-guide-done=""
          className="absolute -right-1 -bottom-1 size-2 rounded-sm bg-background text-muted-foreground"
        />
      )}
    </span>
  );
}
