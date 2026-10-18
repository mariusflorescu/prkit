import type { AccountId, CommentPlacement, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { askAbout } from "~/features/ask/askStore";
import { useAskTarget } from "~/features/ask/askTarget";
import { addNoteComment, addPendingComment } from "~/rpc/client";
import { pendingCommentsQuery } from "~/rpc/queries";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { storePending } from "./reviewCommentsCache";
import { rangeLabel } from "./reviewCommentPresentation";
import { type NoteDraft, useReviewCommentsStore } from "./reviewCommentsStore";

/**
 * The inline composer under the selected lines, or under a guide note with the note's
 * words to edit. What it adds waits for the review.
 */
export function NewCommentComposer({
  pr,
  placement,
  note,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  placement: CommentPlacement;
  note: NoteDraft | null;
}) {
  const client = useQueryClient();
  const close = useReviewCommentsStore((state) => state.closeComposer);
  const ask = useAskTarget();
  const add = useMutation({
    mutationFn: (body: string) =>
      note === null
        ? addPendingComment({ ...pr, placement, body })
        : addNoteComment({ ...pr, note: note.ref, body }),
    onSuccess: (comments) => {
      storePending(client, pr.key, pr.accountId)(comments);
      close();
    },
    // A draft this note made elsewhere then shows on the note, and these words stay.
    onError: () => {
      if (note !== null)
        void client.invalidateQueries({
          queryKey: pendingCommentsQuery(pr.key, pr.accountId).queryKey,
        });
    },
  });
  const movedTo = note?.movedTo ?? null;
  const where = rangeLabel(movedTo ?? placement.anchor);
  const label =
    movedTo === null ? `Comment on ${where}` : `Comment on ${where}, where this line is now`;
  return (
    <CommentCard draft label={`New comment on ${placement.anchor.path} ${where}`}>
      <div className="mb-2 text-xs text-muted-foreground">
        <p>{label}</p>
        {note !== null && <p>Starts as the guide's note. Edit it before you add it.</p>}
      </div>
      <CommentForm
        label={label}
        submitLabel="Add review comment"
        pendingLabel="Adding..."
        defaultValue={note?.text ?? ""}
        error={add.error?.message ?? null}
        pending={add.isPending}
        onSubmit={(body) => add.mutate(body)}
        onCancel={close}
        {...(ask === null || note !== null
          ? {}
          : {
              aside: {
                label: "Ask about these lines",
                // A comment already begun stays where it is, under its lines.
                onClick: (body: string) => {
                  if (body.trim() === "") close();
                  askAbout(ask.key, {
                    scope: { _tag: "lines", anchor: placement.anchor },
                    revision: ask.revision,
                  });
                },
              },
            })}
      />
    </CommentCard>
  );
}
