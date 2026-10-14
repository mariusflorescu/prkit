import type { ReviewFeedEntry } from "@prkit/contracts";
import { BookOpenTextIcon } from "lucide-react";

/** "Guide ready" once a PR has a guide, "Writing guide" while its first one is written. */
export function InboxGuideMark({ review }: { review: ReviewFeedEntry | undefined }) {
  if (review === undefined) return null;
  const writing = review.status === "preparing" || review.status === "writing";
  if (review.latestRevision === null && !writing) return null;
  return (
    <span
      data-guide-mark={review.latestRevision === null ? "writing" : "ready"}
      className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"
    >
      <BookOpenTextIcon aria-hidden="true" className="size-3" />
      {review.latestRevision === null ? "Writing guide" : "Guide ready"}
    </span>
  );
}
