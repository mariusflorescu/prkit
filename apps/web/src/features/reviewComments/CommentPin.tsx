import type {
  AccountId,
  CommentPlacement,
  Landed,
  PendingComment,
  PullRequestKey,
  ReviewThread,
} from "@prkit/contracts";

import { NewCommentComposer } from "./NewCommentComposer";
import { PendingCommentCard } from "./PendingCommentCard";
import type { NoteDraft } from "./reviewCommentsStore";
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
  drafts: ReadonlyArray<{ comment: PendingComment; placed: Landed }>;
  composer: { placement: CommentPlacement; note: NoteDraft | null } | null;
}) {
  return (
    <div data-comment-pin="" className="py-1">
      {threads.map((thread) => (
        <ReviewThreadCard key={thread.id} thread={thread} pr={pr} />
      ))}
      {drafts.map(({ comment, placed }) => (
        <PendingCommentCard key={comment.id} comment={comment} pr={pr} placed={placed} />
      ))}
      {composer && (
        <NewCommentComposer
          // Pierre keys its annotation slots by position, so one note's words would stay
          // in the field when the composer moves to another note.
          key={
            composer.note === null
              ? "lines"
              : `${composer.note.ref.revision}:${composer.note.ref.path}:${composer.note.ref.index}`
          }
          pr={pr}
          placement={composer.placement}
          note={composer.note}
        />
      )}
    </div>
  );
}
