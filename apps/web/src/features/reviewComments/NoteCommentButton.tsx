import {
  type AccountId,
  capture,
  NOTE_LOST,
  type NoteKey,
  notePoint,
  placeOn,
  type PullRequestKey,
} from "@prkit/contracts";
import { useMutation } from "@tanstack/react-query";
import { MessageSquarePlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { getPullRequestFiles } from "~/rpc/client";
import { rangeLabel } from "./reviewCommentPresentation";
import { useReviewCommentsStore } from "./reviewCommentsStore";
import { samePoint, type ShownNote } from "./shownNote";

/**
 * Opens the note's own composer under a question or risk note, holding the note's words, beside
 * any other comment being written. The click reads GitHub's diff now, so a line that changed
 * after the guide was written is refused before anyone types; the server places the draft again
 * when it is added.
 */
export function NoteCommentButton({
  pr,
  note,
  noteKey,
  composing,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  note: ShownNote;
  noteKey: NoteKey | null;
  composing: boolean;
}) {
  const compose = useReviewCommentsStore((state) => state.compose);
  const { on, ref, written, writtenRows, writtenHead, at, rows, head } = note;
  const start = useMutation({
    // Read again on every click: the Files tab's copy never goes stale on its own.
    mutationFn: () => getPullRequestFiles(pr.key, pr.accountId),
    onSuccess: (files) => {
      const point = notePoint(written);
      const captured = capture(
        writtenRows,
        { path: ref.path, start: point, end: point },
        writtenHead,
      );
      const placed = captured && placeOn(captured, files);
      const here = capture(rows, { path: ref.path, start: at, end: at }, head);
      if (placed === null || placed._tag === "outdated" || here === null || noteKey === null)
        toastManager.add({
          type: "warning",
          ...NOTE_LOST[placed?._tag === "outdated" ? placed.why : "lines"],
        });
      else
        compose({
          pr,
          site: on === "files" ? { on } : { on, revision: ref.revision },
          placement: here,
          note: {
            ref,
            remark: noteKey,
            text: written.text,
            movedTo: samePoint(placed.placement.anchor.end, at) ? null : placed.placement.anchor,
          },
        });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't read the latest code",
        description: error.message,
      }),
  });
  return (
    <div className="mt-2">
      <Button
        size="xs"
        variant="outline"
        aria-label={
          start.isPending
            ? undefined
            : `Add as comment, ${written.tone} on ${rangeLabel({ start: at, end: at })}`
        }
        disabled={composing || start.isPending}
        onClick={() => start.mutate()}
      >
        <MessageSquarePlusIcon aria-hidden="true" />
        {start.isPending ? "Checking..." : "Add as comment"}
      </Button>
    </div>
  );
}
