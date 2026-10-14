import type { AttemptSummary, Review } from "@prkit/contracts";

import { CheckedAgo } from "./CheckedAgo";
import { ElapsedTime } from "./ElapsedTime";
import { guideProgress } from "./progressModel";
import { ENDED_LINES, updateLine } from "./reviewPresentation";

/** What the review is doing now, in one line over a guide that already exists. */
export function ReviewStatusLine({
  status,
  watchProblem,
  attempt,
}: {
  status: Review["status"];
  watchProblem: string | null;
  attempt: AttemptSummary | null;
}) {
  switch (status._tag) {
    case "watching":
      return (
        <span className="min-w-0 truncate" title={watchProblem ?? undefined}>
          Watching for new commits ·{" "}
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
          {attempt === null ? "Updating the guide" : updateLine(attempt)}
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
      return <span className="min-w-0 truncate">{ENDED_LINES[status.reason]}</span>;
  }
}
