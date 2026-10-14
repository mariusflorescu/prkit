import type { PullRequestDetail, Review, ReviewStatus } from "@prkit/contracts";

import { GuideSetup } from "./GuideSetup";
import { ReviewAlert } from "./ReviewAlert";
import { FAILURE_TITLES } from "./reviewPresentation";
import { useReviewActions } from "./useReviewActions";

/** A first guide that failed: why, Retry with the same agent, or start over with another. */
export function GuideFailed({
  detail,
  review,
  status,
}: {
  detail: PullRequestDetail;
  review: Review;
  status: Extract<ReviewStatus, { _tag: "failed" }>;
}) {
  const { retry } = useReviewActions(detail.key);
  return (
    <div className="mx-auto w-full max-w-2xl">
      <ReviewAlert
        title={FAILURE_TITLES[status.reason]}
        message={retry.error?.message ?? status.message}
        {...(status.reason === "account" ? { detail: `Read through ${detail.accountId}` } : {})}
        retry={() => retry.mutate()}
        retrying={retry.isPending}
      />
      <div className="px-6 pb-10">
        <p className="mb-2 text-xs text-muted-foreground">Or start again with other settings</p>
        <GuideSetup detail={detail} review={review} submitLabel="Generate guide" frame="card" />
      </div>
    </div>
  );
}
