import type { AttemptId, DiffSource, ReviewKey } from "@prkit/contracts";
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
  reviewKey,
  attemptId,
  version,
  growing,
  source,
  prUrl,
  prDescription,
}: {
  reviewKey: ReviewKey;
  attemptId: AttemptId;
  version: number;
  /** The agent is still adding chapters to a streamed guide. */
  growing: boolean;
  /** Where the diff's scope lines read the new side; null reads none. */
  source: DiffSource | null;
  prUrl?: string;
  prDescription?: string;
}) {
  const draft = useQuery({
    ...draftQuery(reviewKey, attemptId, version),
    placeholderData: keepPreviousData,
  });
  const diff = useQuery(attemptDiffQuery(reviewKey, attemptId));
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
      source={source}
      {...(prUrl === undefined ? {} : { prUrl })}
      {...(prDescription === undefined ? {} : { prDescription })}
      pendingChapterIds={pending}
      draft={{ growing }}
    />
  );
}
