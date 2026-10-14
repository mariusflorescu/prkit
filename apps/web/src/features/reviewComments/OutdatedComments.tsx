import type {
  AccountId,
  CommentPlacement,
  PendingComment,
  PullRequestKey,
  ReviewThread,
} from "@prkit/contracts";

import { PendingCommentCard } from "./PendingCommentCard";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * Comments whose lines are no longer in this diff. Drafts stay in view because they
 * need a new line before they can be sent; GitHub's outdated threads fold away.
 */
export function OutdatedComments({
  pr,
  path,
  drafts,
  threads,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  path: string;
  drafts: ReadonlyArray<{ comment: PendingComment; suggestion: CommentPlacement | null }>;
  threads: ReadonlyArray<ReviewThread>;
}) {
  return (
    <section
      aria-label={`Outdated comments on ${path}`}
      data-outdated-comments=""
      className="border-t border-border/60 py-1"
    >
      {drafts.map(({ comment, suggestion }) => (
        <PendingCommentCard key={comment.id} comment={comment} pr={pr} outdated={{ suggestion }} />
      ))}
      {threads.length > 0 && (
        <details className="group/outdated px-3 py-1">
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
