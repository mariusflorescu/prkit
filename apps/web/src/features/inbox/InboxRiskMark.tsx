import type { ReviewFeedEntry } from "@prkit/contracts";

import { RiskTag } from "~/components/guide/RiskTag";

/** The chip is taller than the title's line, so the wrapper holds the line's height and the row doesn't grow when it appears. */
export function InboxRiskMark({ review }: { review: ReviewFeedEntry | undefined }) {
  if (review === undefined || review.risk === null) return null;
  return (
    <span data-inbox-risk={review.risk} className="flex h-5 shrink-0 items-center">
      <RiskTag level={review.risk} />
    </span>
  );
}
