import type { LocalReview, LocalReviewSnapshot } from "@prkit/contracts";
import { FolderGit2Icon } from "lucide-react";

import { GuideProgress } from "~/components/review/GuideProgress";
import { GuideSkeleton } from "~/components/review/GuideSkeleton";
import { ReviewAlert } from "~/components/review/ReviewAlert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

import { LOCAL_FAILURE_TITLES } from "./localPresentation";
import { LocalGuideReady } from "./LocalGuideReady";
import { useLocalReviewActions } from "./useLocalReviewActions";

/** One screen per state, as the PR Guide tab has; a written guide stays readable whatever runs. */
export function LocalGuideBody({
  snapshot,
  review,
}: {
  snapshot: LocalReviewSnapshot;
  review: LocalReview;
}) {
  const { retry } = useLocalReviewActions(review.key);
  const latest = snapshot.revisions.at(-1);
  if (latest !== undefined)
    return (
      <LocalGuideReady
        review={review}
        attempt={snapshot.attempt}
        revisions={snapshot.revisions}
        latest={latest}
      />
    );
  const status = review.status;
  switch (status._tag) {
    case "preparing":
    case "writing":
      return snapshot.attempt === null ? (
        <GuideSkeleton />
      ) : (
        <GuideProgress
          reviewKey={review.key}
          review={review}
          attempt={snapshot.attempt}
          activity={snapshot.activity}
          subject="your changes"
          expectedFiles={3}
          source={{ _tag: "local", key: review.key, attemptId: snapshot.attempt.id }}
        />
      );
    case "failed":
      return (
        <div className="mx-auto w-full max-w-2xl">
          <ReviewAlert
            title={LOCAL_FAILURE_TITLES[status.reason]}
            message={retry.error?.message ?? status.message}
            retry={() => retry.mutate()}
            retrying={retry.isPending}
          />
        </div>
      );
    case "ready":
    case "done":
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2Icon />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              Stopped before a guide was written
            </EmptyTitle>
            <EmptyDescription>
              Run again to take a new snapshot of your changes and have your agent write one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
  }
}
