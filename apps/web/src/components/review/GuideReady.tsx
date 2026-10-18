import {
  type AttemptConfig,
  type AttemptSummary,
  type DiffFile,
  forReader,
  type PullRequestDetail,
  type Review,
  type RevisionSummary,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { LoadContents } from "~/components/diff";
import { useLineFocus } from "~/components/diff/lineFocus";
import { GuideView } from "~/components/guide";
import { askAside } from "~/features/ask/askAside";
import { AskDock } from "~/features/ask/AskDock";
import { type AskTarget, AskTargetContext } from "~/features/ask/askTarget";
import { useAsks } from "~/features/ask/useAsks";
import { useReviewCommentsStore } from "~/features/reviewComments/reviewCommentsStore";
import { useDiffComments } from "~/features/reviewComments/useDiffComments";
import { useManualCheckTicks } from "~/features/manualCheck/useManualCheckTicks";
import { useNoteComposerHold } from "~/features/reviewComments/useNoteComposerHold";
import { ReviewedCount } from "~/features/reviewedFiles/ReviewedCount";
import { useReviewedFiles } from "~/features/reviewedFiles/useReviewedFiles";
import { getFileContents } from "~/rpc/client";
import { guideQuery, pendingCommentsQuery } from "~/rpc/queries";

import { GuidanceNoteLine } from "./config/GuidanceNoteLine";
import { DescriptionFromGuide } from "./description/DescriptionFromGuide";
import { DraftView } from "./DraftView";
import { GuideSkeleton } from "./GuideSkeleton";
import { GuideStatusBar } from "./GuideStatusBar";
import { ReviewAlert } from "./ReviewAlert";
import { FAILURE_TITLES } from "./reviewPresentation";
import type { GuideChoice } from "./RevisionSwitcher";
import { useReviewActions } from "./useReviewActions";

const noFiles: ReadonlyArray<DiffFile> = [];

/** What the pre-flight says about the description itself, if anything. */
const descriptionNote = (detail: PullRequestDetail, config: AttemptConfig) =>
  detail.body.trim() === ""
    ? "Your pull request has no description yet."
    : config.preflight !== null && config.preflight.description !== detail.body.trim()
      ? "You changed the description after this guide was written, so what it says about the description may be out of date."
      : null;

/**
 * A review with at least one accepted revision. The guide stays readable whatever
 * the review is doing; the bar above it says what that is.
 */
export function GuideReady({
  detail,
  review,
  attempt,
  revisions,
  latest,
}: {
  detail: PullRequestDetail;
  review: Review;
  attempt: AttemptSummary | null;
  revisions: ReadonlyArray<RevisionSummary>;
  latest: RevisionSummary;
}) {
  // null follows the newest revision, so a new one shows up on its own; "draft" reads the
  // update being written until it is accepted, then follows the newest again.
  const [picked, setPicked] = useState<GuideChoice | null>(null);
  const status = review.status;
  const running = status._tag === "preparing" || status._tag === "writing";
  const draft =
    running && attempt?.draft != null
      ? { attempt, version: attempt.draft.version, growing: attempt.draft.growing }
      : null;
  const composingRevision = useNoteComposerHold(detail.key, "guide");
  const closeComposer = useReviewCommentsStore((state) => state.closeComposer);
  // Nor a description being edited from the guide: the revision it drafts from holds until it closes.
  const [describing, setDescribing] = useState<number | null>(null);
  const revision =
    revisions.find((entry) => entry.revision === picked) ??
    revisions.find((entry) => entry.revision === composingRevision) ??
    revisions.find((entry) => entry.revision === describing) ??
    latest;
  const pick = useCallback(
    (next: GuideChoice) => {
      if (composingRevision !== null && next !== composingRevision) closeComposer();
      if (describing !== null && next !== describing) setDescribing(null);
      setPicked(next === latest.revision ? null : next);
    },
    [composingRevision, closeComposer, describing, latest.revision],
  );
  const reveal = useLineFocus((state) => state.reveal);
  const clear = useLineFocus((state) => state.clear);
  // A line asked for here is for this guide only.
  useEffect(() => () => clear(), [clear]);
  const target = useMemo<AskTarget>(
    () => ({
      key: detail.key,
      reviewId: review.id,
      revision: revision.revision,
      openLine: (asked, path, line) => {
        if (asked !== revision.revision) pick(asked);
        reveal({ revision: asked, path, line });
      },
    }),
    [detail.key, review.id, revision.revision, pick, reveal],
  );
  const aside = useMemo(() => askAside(target), [target]);
  const showingDraft = picked === "draft" && draft !== null;
  // Answers can repeat the author's pre-flight, so like it they are the review's own account's.
  const askable = !showingDraft && review.accountId === detail.accountId;
  const guide = useQuery(guideQuery(detail.key, revision.revision));
  const shown = useMemo(
    () =>
      guide.data === undefined
        ? undefined
        : forReader(guide.data, review.accountId, detail.accountId),
    [guide.data, review.accountId, detail.accountId],
  );
  const asks = useAsks(review.id);
  // Notes show what became of their drafts with the first paint, not a moment later.
  const drafts = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const { retry } = useReviewActions(detail.key);
  const reviewed = useReviewedFiles(detail.key, detail.accountId);
  const manualCheckTicks = useManualCheckTicks({
    _tag: "pull-request",
    key: detail.key,
    accountId: detail.accountId,
  });
  const loadContents = useCallback<LoadContents>(
    async (file) => {
      const read = (path: string, side: "old" | "new") =>
        getFileContents(detail.key, detail.accountId, path, side).then((result) => result.content);
      const [oldContents, newContents] = await Promise.all([
        file.status === "added" ? "" : read(file.previousPath ?? file.path, "old"),
        file.status === "removed" ? "" : read(file.path, "new"),
      ]);
      return { oldContents, newContents };
    },
    [detail.key, detail.accountId],
  );
  // Unchanged lines come from GitHub at the PR's current head, so they only match a guide written for it.
  const current = detail.headSha === revision.headSha;
  const comments = useDiffComments(detail, guide.data?.snapshot.files ?? noFiles, {
    commitSha: revision.headSha,
    threads: current,
    outdated: false,
    notes: { on: "guide", revision: revision.revision },
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AskTargetContext value={askable ? target : null}>
        <GuideStatusBar
          detail={detail}
          review={review}
          attempt={attempt}
          revisions={revisions}
          selected={showingDraft ? "draft" : revision.revision}
          onSelect={pick}
          shown={
            guide.data === undefined || showingDraft
              ? null
              : { config: guide.data.config, latest: revision.revision === latest.revision }
          }
        />
        {status._tag === "failed" && (
          <ReviewAlert
            title={FAILURE_TITLES[status.reason]}
            message={retry.error?.message ?? status.message}
            {...(status.reason === "account" ? { detail: `Read through ${detail.accountId}` } : {})}
            retry={() => retry.mutate()}
            retrying={retry.isPending}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {showingDraft ? (
            <div className="min-h-0 flex-1">
              <DraftView
                reviewKey={detail.key}
                attemptId={draft.attempt.id}
                version={draft.version}
                growing={draft.growing}
                source={{ _tag: "attempt", key: detail.key, attemptId: draft.attempt.id }}
                prUrl={detail.url}
                prDescription={detail.body}
              />
            </div>
          ) : guide.isPending ||
            drafts.isPending ||
            reviewed.status === "pending" ||
            manualCheckTicks.status === "pending" ||
            (askable && asks.state._tag === "loading") ? (
            <GuideSkeleton />
          ) : guide.isError ? (
            <ReviewAlert
              title="Couldn't load the guide"
              message={guide.error.message}
              retry={() => void guide.refetch()}
            />
          ) : (
            <>
              {drafts.isError && (
                <ReviewAlert
                  title="Couldn't load your pending comments"
                  message={drafts.error.message}
                  retry={() => void drafts.refetch()}
                />
              )}
              {guide.data.normalized.guidanceNote !== null && (
                <GuidanceNoteLine note={guide.data.normalized.guidanceNote} />
              )}
              <GuideView
                key={revision.revision}
                revision={revision.revision}
                guide={guide.data.normalized}
                snapshot={guide.data.snapshot}
                source={{ _tag: "attempt", key: detail.key, attemptId: revision.attemptId }}
                prUrl={detail.url}
                prDescription={detail.body}
                comments={comments}
                {...(askable ? { aside } : {})}
                {...(current ? { loadContents } : {})}
                reviewed={reviewed.status === "ready" ? reviewed : undefined}
                manualCheckTicks={manualCheckTicks}
                count={<ReviewedCount reviewed={reviewed} files={guide.data.snapshot.files} />}
                preflight={
                  shown === undefined || shown.normalized.preflight === null
                    ? undefined
                    : {
                        note: descriptionNote(detail, shown.config),
                        action: (
                          <DescriptionFromGuide
                            detail={detail}
                            guide={shown.normalized}
                            open={describing !== null}
                            onOpenChange={(open) => setDescribing(open ? revision.revision : null)}
                          />
                        ),
                      }
                }
              />
            </>
          )}
        </div>
        {askable && <AskDock target={target} />}
      </AskTargetContext>
    </div>
  );
}
