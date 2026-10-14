import type {
  AttemptSummary,
  DiffFile,
  PullRequestDetail,
  Review,
  RevisionSummary,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { LoadContents } from "~/components/diff";
import { GuideView } from "~/components/guide";
import { useDiffComments } from "~/features/reviewComments/useDiffComments";
import { getFileContents } from "~/rpc/client";
import { guideQuery } from "~/rpc/queries";

import { GuidanceNoteLine } from "./config/GuidanceNoteLine";
import { DraftView } from "./DraftView";
import { GuideSkeleton } from "./GuideSkeleton";
import { GuideStatusBar } from "./GuideStatusBar";
import { ReviewAlert } from "./ReviewAlert";
import { FAILURE_TITLES } from "./reviewPresentation";
import type { GuideChoice } from "./RevisionSwitcher";
import { useReviewActions } from "./useReviewActions";

const noFiles: ReadonlyArray<DiffFile> = [];

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
  const revision = revisions.find((entry) => entry.revision === picked) ?? latest;
  const guide = useQuery(guideQuery(detail.key, revision.revision));
  const { retry } = useReviewActions(detail.key);
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
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <GuideStatusBar
        detail={detail}
        review={review}
        attempt={attempt}
        revisions={revisions}
        selected={picked === "draft" && draft !== null ? "draft" : revision.revision}
        onSelect={(next) => setPicked(next === latest.revision ? null : next)}
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
      ) : guide.isPending ? (
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
            prUrl={detail.url}
            prDescription={detail.body}
            comments={comments}
            {...(current ? { loadContents } : {})}
          />
        </>
      )}
    </div>
  );
}
