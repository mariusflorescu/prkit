import type { AttemptSummary, LocalReview, RevisionSummary } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { LoadContents } from "~/components/diff";
import { GuideView } from "~/components/guide";
import { GuidanceNoteLine } from "~/components/review/config/GuidanceNoteLine";
import { DraftView } from "~/components/review/DraftView";
import { GuideSkeleton } from "~/components/review/GuideSkeleton";
import { ReviewAlert } from "~/components/review/ReviewAlert";
import type { GuideChoice } from "~/components/review/RevisionSwitcher";
import { useManualCheckTicks } from "~/features/manualCheck/useManualCheckTicks";
import { getLocalFileContents } from "~/rpc/client";
import { guideQuery } from "~/rpc/queries";

import { isRunning, LOCAL_FAILURE_TITLES } from "./localPresentation";
import { LocalGuideStatusBar } from "./LocalGuideStatusBar";
import { useLocalReviewActions } from "./useLocalReviewActions";

/**
 * A local review with at least one revision: the status bar, then the guide filling the rest.
 * prkit keeps every revision's snapshot, so any revision's files open in full.
 */
export function LocalGuideReady({
  review,
  attempt,
  revisions,
  latest,
}: {
  review: LocalReview;
  attempt: AttemptSummary | null;
  revisions: ReadonlyArray<RevisionSummary>;
  latest: RevisionSummary;
}) {
  // null follows the newest revision; "draft" reads the update being written until it lands.
  const [picked, setPicked] = useState<GuideChoice | null>(null);
  const status = review.status;
  const draft =
    isRunning(status) && attempt?.draft != null
      ? { attempt, version: attempt.draft.version, growing: attempt.draft.growing }
      : null;
  const revision = revisions.find((entry) => entry.revision === picked) ?? latest;
  const guide = useQuery(guideQuery(review.key, revision.revision));
  const { retry } = useLocalReviewActions(review.key);
  const manualCheckTicks = useManualCheckTicks({ _tag: "local", key: review.key });
  const loadContents = useCallback<LoadContents>(
    async (file) => {
      const read = (path: string, side: "old" | "new") =>
        getLocalFileContents(review.key, revision.revision, path, side).then(
          (result) => result.content,
        );
      const [oldContents, newContents] = await Promise.all([
        file.status === "added" ? "" : read(file.previousPath ?? file.path, "old"),
        file.status === "removed" ? "" : read(file.path, "new"),
      ]);
      return { oldContents, newContents };
    },
    [review.key, revision.revision],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LocalGuideStatusBar
        review={review}
        attempt={attempt}
        revisions={revisions}
        selected={picked === "draft" && draft !== null ? "draft" : revision.revision}
        onSelect={(next) => setPicked(next === latest.revision ? null : next)}
      />
      {status._tag === "failed" && (
        <ReviewAlert
          title={LOCAL_FAILURE_TITLES[status.reason]}
          message={retry.error?.message ?? status.message}
          retry={() => retry.mutate()}
          retrying={retry.isPending}
        />
      )}
      {picked === "draft" && draft !== null ? (
        <div className="min-h-0 flex-1">
          <DraftView
            reviewKey={review.key}
            attemptId={draft.attempt.id}
            version={draft.version}
            growing={draft.growing}
            source={{ _tag: "local", key: review.key, attemptId: draft.attempt.id }}
          />
        </div>
      ) : guide.isPending || manualCheckTicks.status === "pending" ? (
        <GuideSkeleton />
      ) : guide.isError ? (
        <ReviewAlert
          title="Couldn't load the guide"
          message={guide.error.message}
          retry={() => void guide.refetch()}
        />
      ) : (
        <>
          {guide.data.normalized.guidanceNote !== null && (
            <GuidanceNoteLine note={guide.data.normalized.guidanceNote} />
          )}
          <GuideView
            key={revision.revision}
            guide={guide.data.normalized}
            snapshot={guide.data.snapshot}
            loadContents={loadContents}
            manualCheckTicks={manualCheckTicks}
            source={{ _tag: "local", key: review.key, attemptId: revision.attemptId }}
          />
        </>
      )}
    </div>
  );
}
