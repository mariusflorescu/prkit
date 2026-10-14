import type { AttemptId, PullRequestDetail } from "@prkit/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { GuideView } from "~/components/guide";
import { attemptDiffQuery, draftQuery } from "~/rpc/queries";

import { GuideSkeleton } from "./GuideSkeleton";
import { ReviewAlert } from "./ReviewAlert";

/**
 * The guide as the agent drafts it: the overview first, then each chapter as it
 * lands, with planned chapters faded. A newer draft replaces the older one in place.
 */
export function DraftView({
  detail,
  attemptId,
  version,
  growing,
}: {
  detail: PullRequestDetail;
  attemptId: AttemptId;
  version: number;
  /** The agent is still adding chapters to a streamed guide. */
  growing: boolean;
}) {
  const draft = useQuery({
    ...draftQuery(detail.key, attemptId, version),
    placeholderData: keepPreviousData,
  });
  const diff = useQuery(attemptDiffQuery(detail.key, attemptId));
  if (draft.isPending || diff.isPending) return <GuideSkeleton label="Loading the draft" />;
  if (draft.isError || diff.isError)
    return (
      <ReviewAlert
        title="Couldn't load the draft"
        message={(draft.error ?? diff.error)?.message ?? "Try again."}
        retry={() => {
          void draft.refetch();
          void diff.refetch();
        }}
      />
    );
  const pending = new Set(
    draft.data.normalized.chapters
      .filter((chapter) => chapter.files.length === 0)
      .map((chapter) => chapter.id),
  );
  return (
    <GuideView
      key={attemptId}
      guide={draft.data.normalized}
      snapshot={diff.data}
      prUrl={detail.url}
      prDescription={detail.body}
      pendingChapterIds={pending}
      draft={{ growing }}
    />
  );
}
