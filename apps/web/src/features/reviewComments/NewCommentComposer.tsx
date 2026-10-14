import type { AccountId, CommentPlacement, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { addPendingComment } from "~/rpc/client";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { storePending } from "./reviewCommentsCache";
import { rangeLabel } from "./reviewCommentPresentation";
import { useReviewCommentsStore } from "./reviewCommentsStore";

/** The inline composer under the selected lines. What it adds waits for the review. */
export function NewCommentComposer({
  pr,
  placement,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  placement: CommentPlacement;
}) {
  const client = useQueryClient();
  const close = useReviewCommentsStore((state) => state.closeComposer);
  const add = useMutation({
    mutationFn: (body: string) => addPendingComment({ ...pr, placement, body }),
    onSuccess: (comments) => {
      storePending(client, pr.key, pr.accountId)(comments);
      close();
    },
  });
  const where = rangeLabel(placement.anchor);
  return (
    <CommentCard draft label={`New comment on ${placement.anchor.path} ${where}`}>
      <p className="mb-2 text-xs text-muted-foreground">Comment on {where}</p>
      <CommentForm
        label={`Comment on ${where}`}
        submitLabel="Add review comment"
        pendingLabel="Adding..."
        error={add.error?.message ?? null}
        pending={add.isPending}
        onSubmit={(body) => add.mutate(body)}
        onCancel={close}
      />
    </CommentCard>
  );
}
