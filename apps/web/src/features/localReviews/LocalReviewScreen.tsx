import type { LocalReviewKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ReviewAlert } from "~/components/review/ReviewAlert";
import { ReviewFeedNotice } from "~/components/review/ReviewFeedNotice";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { localReviewQuery } from "~/rpc/queries";

import { LocalGuideBody } from "./LocalGuideBody";
import { LocalLeftOut } from "./LocalLeftOut";
import { LocalReviewGone } from "./LocalReviewGone";
import { LocalReviewHeader } from "./LocalReviewHeader";
import { LocalReviewSkeleton } from "./LocalReviewSkeleton";
import { useLocalReviewWatch } from "./useLocalReviewWatch";

/**
 * A local review's page: what it is about and what you can do, then its guide. While prkit
 * can't read it, a notice says so, and only a written guide stays, as it was last read.
 */
export function LocalReviewScreen({ reviewKey }: { reviewKey: LocalReviewKey }) {
  const { problem, retry } = useLocalReviewWatch(reviewKey);
  const snapshot = useQuery(localReviewQuery(reviewKey));
  const workspace = useWorkspace();
  const present = snapshot.data?.review != null;
  const synced = useRef(false);
  // A page reached by a link or a notification gets its tab too.
  useEffect(() => {
    if (!present || workspace.data === undefined || synced.current) return;
    synced.current = true;
    workspace.ensureLocal(reviewKey);
  }, [present, reviewKey, workspace]);
  if (snapshot.isPending) return <LocalReviewSkeleton />;
  if (snapshot.isError)
    return (
      <ReviewAlert
        title="Couldn't load this local review"
        message={snapshot.error.message}
        retry={() => void snapshot.refetch()}
      />
    );
  const { review, run, revisions } = snapshot.data;
  if (review === null) return <LocalReviewGone />;
  const written = revisions.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LocalReviewHeader review={review} run={run} />
      {run !== null && run.leftOut.length > 0 && <LocalLeftOut files={run.leftOut} />}
      {problem !== null && (
        <div className="shrink-0 pt-3 pr-(--workspace-gutter-end) pl-(--workspace-gutter-start)">
          <ReviewFeedNotice label="Couldn't read this local review" message={problem} retry={retry}>
            {written
              ? "The guide below may be out of date until it can."
              : "Its run shows here again once it can."}
          </ReviewFeedNotice>
        </div>
      )}
      {(problem === null || written) && (
        <div className="min-h-0 flex-1">
          <LocalGuideBody snapshot={snapshot.data} review={review} />
        </div>
      )}
    </div>
  );
}
