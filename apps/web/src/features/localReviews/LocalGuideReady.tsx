import type { AttemptSummary, LocalReview, RevisionSummary } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { LoadContents } from "~/components/diff";
import { GuideView } from "~/components/guide";
import { GuidanceNoteLine } from "~/components/review/config/GuidanceNoteLine";
import { DraftView } from "~/components/review/DraftView";
import { GuideSkeleton } from "~/components/review/GuideSkeleton";
import { ReviewAlert } from "~/components/review/ReviewAlert";
import type { GuideChoice } from "~/components/review/RevisionSwitcher";
import { askAside } from "~/features/ask/askAside";
import { AskDock } from "~/features/ask/AskDock";
import { useAsks } from "~/features/ask/useAsks";
import { useGuideAskTarget } from "~/features/ask/useGuideAskTarget";
import { useLineAsks } from "~/features/ask/useLineAsks";
import { useManualCheckTicks } from "~/features/manualCheck/useManualCheckTicks";
import { getLocalFileContents } from "~/rpc/client";
import { guideQuery, localReviewProblemQuery } from "~/rpc/queries";

import { isRunning, LOCAL_FAILURE_TITLES } from "./localPresentation";
import { LocalGuideStatusBar } from "./LocalGuideStatusBar";
import { useLocalReviewActions } from "./useLocalReviewActions";

/**
 * A local review with at least one revision: the status bar, then the guide filling the rest
 * with the Ask dock under it. prkit keeps every revision's snapshot, so any revision's files
 * open in full.
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
  // While prkit can't read the review, the run it last saw may be over: only revisions show.
  const unreadable = useQuery(localReviewProblemQuery(review.key)).data != null;
  const draft =
    !unreadable && isRunning(status) && attempt?.draft != null
      ? { attempt, version: attempt.draft.version, growing: attempt.draft.growing }
      : null;
  const showingDraft = picked === "draft" && draft !== null;
  const revision = revisions.find((entry) => entry.revision === picked) ?? latest;
  const pick = useCallback(
    (next: GuideChoice) => setPicked(next === latest.revision ? null : next),
    [latest.revision],
  );
  const target = useGuideAskTarget({
    key: review.key,
    reviewId: review.id,
    revision: revision.revision,
    pick,
  });
  const aside = useMemo(() => askAside(target), [target]);
  const lineAsks = useLineAsks(target, revision.headSha);
  const asks = useAsks(review.id);
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
        selected={showingDraft ? "draft" : revision.revision}
        onSelect={pick}
      />
      {status._tag === "failed" && !unreadable && (
        <ReviewAlert
          title={LOCAL_FAILURE_TITLES[status.reason]}
          message={retry.error?.message ?? status.message}
          retry={() => retry.mutate()}
          retrying={retry.isPending}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {showingDraft ? (
          <div className="min-h-0 flex-1">
            <DraftView
              reviewKey={review.key}
              attemptId={draft.attempt.id}
              version={draft.version}
              growing={draft.growing}
              source={{ _tag: "local", key: review.key, attemptId: draft.attempt.id }}
            />
          </div>
        ) : guide.isPending ||
          manualCheckTicks.status === "pending" ||
          asks.state._tag === "loading" ? (
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
              revision={revision.revision}
              guide={guide.data.normalized}
              snapshot={guide.data.snapshot}
              loadContents={loadContents}
              manualCheckTicks={manualCheckTicks}
              source={{ _tag: "local", key: review.key, attemptId: revision.attemptId }}
              interaction={lineAsks}
              aside={aside}
            />
          </>
        )}
      </div>
      {!showingDraft && <AskDock target={target} />}
    </div>
  );
}
