import type {
  AccountId,
  CommentPlacement,
  PendingComment,
  PullRequestKey,
  ReviewThread,
} from "@prkit/contracts";

import { NewCommentComposer } from "./NewCommentComposer";
import { PendingCommentCard } from "./PendingCommentCard";
import { ReviewThreadCard } from "./ReviewThreadCard";

/** Everything under one diff line: GitHub's threads, then drafts, then the composer. */
export function CommentPin({
  pr,
  threads,
  drafts,
  composer,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  threads: ReadonlyArray<ReviewThread>;
  drafts: ReadonlyArray<PendingComment>;
  composer: CommentPlacement | null;
}) {
  return (
    <div data-comment-pin="" className="py-1">
      {threads.map((thread) => (
        <ReviewThreadCard key={thread.id} thread={thread} pr={pr} />
      ))}
      {drafts.map((comment) => (
        <PendingCommentCard key={comment.id} comment={comment} pr={pr} />
      ))}
      {composer && <NewCommentComposer pr={pr} placement={composer} />}
    </div>
  );
}
