import type { AccountId, Outdated, Placed, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { askAbout } from "~/features/ask/askStore";
import { useAskTarget } from "~/features/ask/askTarget";
import { addNoteComment, addPendingComment } from "~/rpc/client";
import { pendingCommentsQuery } from "~/rpc/queries";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { DiffSnippet } from "./DiffSnippet";
import { PlacementTag } from "./PlacementTag";
import { storePending } from "./reviewCommentsCache";
import { rangeLabel } from "./reviewCommentPresentation";
import { type Composer, composerForm, useReviewCommentsStore } from "./reviewCommentsStore";
import { sendingKey, useFormSending } from "./useFormSending";

/** Why a comment being written has no line on this diff, as its card says it. */
const lostWhy = (placed: Outdated) =>
  placed.why === "file"
    ? "GitHub shows no diff for this file now. Add the comment to keep it with your drafts."
    : "A new commit changed these lines while you were writing. Add the comment to keep it with your drafts, then move it to a current line.";

/**
 * The inline composer under the selected lines, or under a guide note with the note's
 * words to edit. It is placed like a draft: after a push it moves with its code, or waits
 * under the file with the lines it was written on. What it adds waits for the review.
 */
export function NewCommentComposer({
  pr,
  composer,
  placed,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  composer: Composer;
  placed: Placed;
}) {
  const client = useQueryClient();
  const closeComposer = useReviewCommentsStore((state) => state.closeComposer);
  const sendFailed = useReviewCommentsStore((state) => state.sendFailed);
  const ask = useAskTarget();
  const { placement, note } = composer;
  const form = composerForm(composer);
  const close = () => closeComposer(form);
  const sending = useFormSending(form);
  // GitHub's diff no longer has the note's line, so the server would refuse it as the note's.
  const fromNote = placed._tag === "outdated" ? null : note;
  const add = useMutation({
    mutationKey: sendingKey(form),
    mutationFn: (body: string) =>
      fromNote === null
        ? addPendingComment({ ...pr, placement, body })
        : addNoteComment({ ...pr, note: fromNote.ref, body }),
    onMutate: () => sendFailed(form, null),
    onSuccess: (comments) => {
      storePending(client, pr.key, pr.accountId)(comments);
      close();
    },
    // A draft this note made elsewhere then shows on the note, and these words stay.
    onError: (error) => {
      sendFailed(form, error.message);
      if (fromNote !== null)
        void client.invalidateQueries({
          queryKey: pendingCommentsQuery(pr.key, pr.accountId).queryKey,
        });
    },
  });
  const written = rangeLabel(placement.anchor);
  const where =
    placed._tag === "outdated"
      ? `written on ${written}`
      : placed._tag === "moved"
        ? `on ${rangeLabel(placed.placement.anchor)}, written on ${written}`
        : note?.movedTo != null
          ? `on ${rangeLabel(note.movedTo)}, where this line is now`
          : `on ${written}`;
  const label = `Comment ${where}`;
  return (
    <CommentCard draft label={`New comment ${where}, in ${placement.anchor.path}`}>
      <div className="mb-2 space-y-1 text-xs text-muted-foreground">
        <p className="flex items-center gap-2">
          {placed._tag !== "kept" && <PlacementTag moved={placed._tag === "moved"} />}
          <span className="min-w-0">{label}</span>
        </p>
        {placed._tag === "moved" && <p>A new commit moved this code, and your comment with it.</p>}
        {placed._tag === "outdated" && (
          <>
            <p>{lostWhy(placed)}</p>
            <DiffSnippet
              text={placement.snippet}
              context={placement.context}
              label="Lines this comment was written on"
            />
          </>
        )}
        {fromNote !== null && <p>Starts as the guide's note. Edit it before you add it.</p>}
      </div>
      <CommentForm
        form={form}
        label={label}
        submitLabel="Add review comment"
        pendingLabel="Adding..."
        pending={sending}
        onSubmit={(body) => add.mutate(body)}
        onCancel={close}
        {...(ask === null || note !== null || placed._tag === "outdated"
          ? {}
          : {
              aside: {
                label: "Ask about these lines",
                // A comment already begun stays where it is, under its lines.
                onClick: (body: string) => {
                  if (body.trim() === "") close();
                  askAbout(ask.key, {
                    scope: { _tag: "lines", anchor: placed.placement.anchor },
                    revision: ask.revision,
                  });
                },
              },
            })}
      />
    </CommentCard>
  );
}
