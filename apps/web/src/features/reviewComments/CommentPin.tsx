import type {
  AccountId,
  Landed,
  PendingComment,
  PullRequestKey,
  ReviewThread,
} from "@prkit/contracts";

import { NewCommentComposer } from "./NewCommentComposer";
import { PendingCommentCard } from "./PendingCommentCard";
import { type Composer, composerForm } from "./reviewCommentsStore";
import { ReviewThreadCard } from "./ReviewThreadCard";

/** Everything under one diff line: GitHub's threads, then drafts, then the comments being written. */
export function CommentPin({
  pr,
  threads,
  drafts,
  composers,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  threads: ReadonlyArray<ReviewThread>;
  drafts: ReadonlyArray<{ comment: PendingComment; placed: Landed }>;
  composers: ReadonlyArray<{ composer: Composer; placed: Landed }>;
}) {
  return (
    <div data-comment-pin="" className="py-1">
      {threads.map((thread) => (
        <ReviewThreadCard key={thread.id} thread={thread} pr={pr} />
      ))}
      {drafts.map(({ comment, placed }) => (
        <PendingCommentCard key={comment.id} comment={comment} pr={pr} placed={placed} />
      ))}
      {composers.map(({ composer, placed }) => (
        <NewCommentComposer
          // Pierre keys its annotation slots by position, so a field would keep another
          // composer's words when that slot shows it.
          key={composerForm(composer)}
          pr={pr}
          composer={composer}
          placed={placed}
        />
      ))}
    </div>
  );
}
