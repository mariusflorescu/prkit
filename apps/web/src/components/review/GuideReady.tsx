import {
  type AttemptConfig,
  type AttemptSummary,
  type DiffFile,
  isAccountLogin,
  type PullRequestDetail,
  type Review,
  type RevisionSummary,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { LoadContents } from "~/components/diff";
import { GuideView } from "~/components/guide";
import { useReviewCommentsStore } from "~/features/reviewComments/reviewCommentsStore";
import { useDiffComments } from "~/features/reviewComments/useDiffComments";
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
  const revision =
    revisions.find((entry) => entry.revision === picked) ??
    revisions.find((entry) => entry.revision === composingRevision) ??
    latest;
  const guide = useQuery(guideQuery(detail.key, revision.revision));
  // Notes show what became of their drafts with the first paint, not a moment later.
  const drafts = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const { retry } = useReviewActions(detail.key);
  const reviewed = useReviewedFiles(detail.key, detail.accountId);
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
      <GuideStatusBar
        detail={detail}
        review={review}
        attempt={attempt}
        revisions={revisions}
        selected={picked === "draft" && draft !== null ? "draft" : revision.revision}
        onSelect={(next) => {
          if (composingRevision !== null && next !== composingRevision) closeComposer();
          setPicked(next === latest.revision ? null : next);
        }}
        shown={
          guide.data === undefined || (picked === "draft" && draft !== null)
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
      {picked === "draft" && draft !== null ? (
        <div className="min-h-0 flex-1">
          <DraftView
            detail={detail}
            attemptId={draft.attempt.id}
            version={draft.version}
            growing={draft.growing}
          />
        </div>
      ) : guide.isPending || drafts.isPending || reviewed.status === "pending" ? (
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
            guide={guide.data.normalized}
            snapshot={guide.data.snapshot}
            source={{ _tag: "attempt", key: detail.key, attemptId: revision.attemptId }}
            prUrl={detail.url}
            prDescription={detail.body}
            comments={comments}
            {...(current ? { loadContents } : {})}
            reviewed={reviewed.status === "ready" ? reviewed : undefined}
            count={<ReviewedCount reviewed={reviewed} files={guide.data.snapshot.files} />}
            preflight={
              isAccountLogin(detail.accountId, detail.author?.login ?? null)
                ? {
                    note: descriptionNote(detail, guide.data.config),
                    action: <DescriptionFromGuide detail={detail} guide={guide.data.normalized} />,
                  }
                : undefined
            }
          />
        </>
      )}
    </div>
  );
}
