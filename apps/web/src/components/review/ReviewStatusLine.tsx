import type { AttemptSummary, LocalReviewStatus, ReviewStatus } from "@prkit/contracts";

import { CheckedAgo } from "./CheckedAgo";
import { ElapsedTime } from "./ElapsedTime";
import { guideProgress } from "./progressModel";
import type { ReviewWords } from "./reviewPresentation";

/** What the review is doing now, in one line over a guide that already exists. */
export function ReviewStatusLine({
  status,
  watchProblem,
  attempt,
  words,
}: {
  status: ReviewStatus | LocalReviewStatus;
  watchProblem: string | null;
  attempt: AttemptSummary | null;
  words: ReviewWords;
}) {
  switch (status._tag) {
    case "ready":
      return <span className="min-w-0 truncate">{words.current}</span>;
    case "watching":
      return (
        <span className="min-w-0 truncate" title={watchProblem ?? undefined}>
          {words.current} ·{" "}
          {watchProblem === null ? (
            <CheckedAgo at={status.checkedAt} />
          ) : (
            <span className="text-warning-foreground">couldn't check: {watchProblem}</span>
          )}
        </span>
      );
    case "preparing":
    case "writing":
      return (
        <span className="min-w-0 truncate" title={attempt?.narration ?? undefined}>
          {attempt === null ? "Updating the guide" : words.update(attempt)}
          {attempt !== null && (
            <>
              {" · "}
              {guideProgress(attempt).label}
              {" · "}
              <ElapsedTime since={attempt.startedAt} />
            </>
          )}
        </span>
      );
    case "failed":
      return <span className="min-w-0 truncate">The guide couldn't be updated</span>;
    case "done":
      return <span className="min-w-0 truncate">{words.ended[status.reason]}</span>;
  }
}
