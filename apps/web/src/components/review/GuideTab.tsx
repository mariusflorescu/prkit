import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { reviewQuery } from "~/rpc/queries";

import { GuideEmpty } from "./GuideEmpty";
import { GuideEnded } from "./GuideEnded";
import { GuideFailed } from "./GuideFailed";
import { GuideProgress } from "./GuideProgress";
import { GuideReady } from "./GuideReady";
import { GuideSkeleton } from "./GuideSkeleton";
import { ReviewAlert } from "./ReviewAlert";
import { useReviewWatch } from "./useReviewWatch";

/** The PR view's Guide tab: one screen per review state. */
export function GuideTab({ detail }: { detail: PullRequestDetail }) {
  useReviewWatch(detail.key);
  const review = useQuery(reviewQuery(detail.key));
  if (review.isPending) return <GuideSkeleton />;
  if (review.isError)
    return (
      <ReviewAlert
        title="Couldn't load the guide"
        message={review.error.message}
        retry={() => void review.refetch()}
      />
    );
  const snapshot = review.data;
  const start = (stopped: boolean) => (
    <GuideEmpty detail={detail} review={snapshot.review} stopped={stopped} />
  );
  if (snapshot.review === null) return start(false);
  const latest = snapshot.revisions.at(-1);
  if (latest !== undefined)
    return (
      <GuideReady
        detail={detail}
        review={snapshot.review}
        attempt={snapshot.attempt}
        revisions={snapshot.revisions}
        latest={latest}
      />
    );
  const status = snapshot.review.status;
  switch (status._tag) {
    case "preparing":
    case "writing":
      return snapshot.attempt === null ? (
        <GuideSkeleton />
      ) : (
        <GuideProgress
          detail={detail}
          review={snapshot.review}
          snapshot={snapshot}
          attempt={snapshot.attempt}
        />
      );
    case "failed":
      return <GuideFailed detail={detail} review={snapshot.review} status={status} />;
    case "done":
      return status.reason !== "stopped" && detail.state !== "open" ? (
        <GuideEnded reason={status.reason} />
      ) : (
        start(true)
      );
    case "watching":
      return start(true);
  }
}
