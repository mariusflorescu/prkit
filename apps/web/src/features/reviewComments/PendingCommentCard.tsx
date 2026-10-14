import type { AccountId, CommentPlacement, PendingComment, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { SendToAgentButton } from "~/features/fixes/SendToAgentButton";
import { PullRequestMarkdown } from "~/features/pullRequest/PullRequestMarkdown";
import { deletePendingComment, editPendingComment, movePendingComment } from "~/rpc/client";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { DiffSnippet } from "./DiffSnippet";
import { storePending } from "./reviewCommentsCache";
import { rangeLabel } from "./reviewCommentPresentation";
import { useReviewCommentsStore } from "./reviewCommentsStore";

/**
 * A draft that goes out with the review. An outdated one shows the lines it was
 * written on and offers to move it, since GitHub only takes it on a current line.
 */
export function PendingCommentCard({
  comment,
  pr,
  outdated = null,
}: {
  comment: PendingComment;
  pr: { key: PullRequestKey; accountId: AccountId };
  /** Set when its lines changed: where the same lines sit now, if they still exist. */
  outdated?: { suggestion: CommentPlacement | null } | null;
}) {
  const client = useQueryClient();
  const store = storePending(client, pr.key, pr.accountId);
  const [editing, setEditing] = useState(false);
  const moving = useReviewCommentsStore((state) => state.moving?.id === comment.id);
  const startMove = useReviewCommentsStore((state) => state.startMove);
  const stopMove = useReviewCommentsStore((state) => state.stopMove);
  const edit = useMutation({
    mutationFn: (body: string) => editPendingComment(comment.id, body),
    onSuccess: (comments) => {
      store(comments);
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePendingComment(comment.id),
    onSuccess: store,
  });
  const move = useMutation({
    mutationFn: (placement: CommentPlacement) => movePendingComment(comment.id, placement),
    onSuccess: store,
  });
  useEffect(() => {
    if (!moving) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") stopMove();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [moving, stopMove]);
  const where = rangeLabel(comment.anchor);
  const error = remove.error ?? move.error;
  const withAgent = comment.state === "sent-to-agent";
  return (
    <CommentCard draft label={`Pending comment on ${comment.anchor.path} ${where}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-warning-surface px-1.5 py-0.5 text-3xs font-medium text-warning-foreground">
          {withAgent ? "With the agent" : "Pending"}
        </span>
        {outdated !== null && (
          <span className="rounded border border-border/60 px-1 text-3xs">Outdated</span>
        )}
        <span className="min-w-0 truncate">{where}</span>
        {/* While the agent works on it, it can't change; its fix ends that in the Fixes tab. */}
        <span className={withAgent ? "hidden" : "ml-auto flex items-center gap-0.5"}>
          <SendToAgentButton
            pr={pr}
            target={{ _tag: "draft", id: comment.id }}
            label={`the comment on ${comment.anchor.path} ${where}`}
          />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Edit pending comment"
            disabled={editing}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label="Delete pending comment"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2Icon />
          </Button>
        </span>
      </div>
      {outdated !== null && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            These lines changed after you wrote this, so it won't be sent until it is on a current
            line.
          </p>
          <DiffSnippet text={comment.snippet} label="Lines this comment was written on" />
          <div className="flex flex-wrap items-center gap-2">
            {outdated.suggestion && (
              <Button
                size="xs"
                variant="outline"
                disabled={move.isPending}
                onClick={() => outdated.suggestion && move.mutate(outdated.suggestion)}
              >
                Move to {rangeLabel(outdated.suggestion.anchor)}
              </Button>
            )}
            {moving ? (
              <>
                <span role="status" className="text-xs text-foreground">
                  Click a line in this file to move the comment there.
                </span>
                <Button size="xs" variant="ghost" onClick={stopMove}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  startMove({ key: pr.key, path: comment.anchor.path, id: comment.id })
                }
              >
                Pick a new line
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="mt-2">
        {editing ? (
          <CommentForm
            label="Edit pending comment"
            submitLabel="Save"
            pendingLabel="Saving..."
            defaultValue={comment.body}
            error={edit.error?.message ?? null}
            pending={edit.isPending}
            onSubmit={(body) => edit.mutate(body)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <PullRequestMarkdown body={comment.body} />
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error-foreground">
          {error.message}
        </p>
      )}
    </CommentCard>
  );
}
