import type {
  AccountId,
  Outdated,
  PendingComment,
  PullRequestKey,
  ReviewThread,
} from "@prkit/contracts";

import { NewCommentComposer } from "./NewCommentComposer";
import { PendingCommentCard } from "./PendingCommentCard";
import {
  type Composer,
  composerKey,
  replyForm,
  useReviewCommentsStore,
} from "./reviewCommentsStore";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * Comments whose lines are no longer in this diff. Drafts and a comment being written stay
 * in view because they need a new line before they can be sent; GitHub's outdated threads
 * fold away, unless a reply to one is being written.
 */
export function OutdatedComments({
  pr,
  path,
  drafts,
  threads,
  composer,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  path: string;
  drafts: ReadonlyArray<{ comment: PendingComment; placed: Outdated }>;
  threads: ReadonlyArray<ReviewThread>;
  composer: { composer: Composer; placed: Outdated } | null;
}) {
  const replying = useReviewCommentsStore((state) =>
    threads.some((thread) => state.words.has(replyForm(pr, thread.id))),
  );
  return (
    <section
      aria-label={`Outdated comments on ${path}`}
      data-outdated-comments=""
      className="border-t border-border/60 py-1"
    >
      {composer && (
        <NewCommentComposer
          key={composerKey(composer.composer)}
          pr={pr}
          composer={composer.composer}
          placed={composer.placed}
        />
      )}
      {drafts.map(({ comment, placed }) => (
        <PendingCommentCard key={comment.id} comment={comment} pr={pr} placed={placed} />
      ))}
      {threads.length > 0 && (
        <details open={replying || undefined} className="group/outdated px-3 py-1">
          <summary className="cursor-pointer list-none py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            Outdated ({threads.length} {threads.length === 1 ? "thread" : "threads"})
          </summary>
          {threads.map((thread) => (
            <ReviewThreadCard key={thread.id} thread={thread} pr={pr} context />
          ))}
        </details>
      )}
    </section>
  );
}
