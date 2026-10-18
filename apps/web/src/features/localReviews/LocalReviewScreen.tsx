import type { LocalReviewKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ReviewAlert } from "~/components/review/ReviewAlert";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { localReviewQuery } from "~/rpc/queries";

import { LocalGuideBody } from "./LocalGuideBody";
import { LocalLeftOut } from "./LocalLeftOut";
import { LocalReviewGone } from "./LocalReviewGone";
import { LocalReviewHeader } from "./LocalReviewHeader";
import { LocalReviewSkeleton } from "./LocalReviewSkeleton";
import { useLocalReviewWatch } from "./useLocalReviewWatch";

/** A local review's page: what it is about and what you can do, then its guide. */
export function LocalReviewScreen({ reviewKey }: { reviewKey: LocalReviewKey }) {
  useLocalReviewWatch(reviewKey);
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
  const { review, run } = snapshot.data;
  if (review === null) return <LocalReviewGone />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LocalReviewHeader review={review} run={run} />
      {run !== null && run.leftOut.length > 0 && <LocalLeftOut files={run.leftOut} />}
      <div className="min-h-0 flex-1">
        <LocalGuideBody snapshot={snapshot.data} review={review} />
      </div>
    </div>
  );
}
