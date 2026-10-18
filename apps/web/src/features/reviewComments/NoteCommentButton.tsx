import {
  type AccountId,
  capture,
  type DiffRow,
  NOTE_LOST,
  notePoint,
  place,
  type PullRequestKey,
} from "@prkit/contracts";
import { useMutation } from "@tanstack/react-query";
import { MessageSquarePlusIcon } from "lucide-react";

import type { DiffAnnotation } from "~/components/diff";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { getPullRequestFiles } from "~/rpc/client";
import { rangeLabel } from "./reviewCommentPresentation";
import { useReviewCommentsStore } from "./reviewCommentsStore";

/**
 * Opens the composer under a question or risk note, holding the note's words. The click
 * reads GitHub's diff now, so a line that changed after the guide was written is refused
 * before anyone types; the server places the draft again when it is added.
 */
export function NoteCommentButton({
  pr,
  path,
  rows,
  revisionHead,
  revision,
  note,
  index,
  composing,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  path: string;
  /** The rows of the revision's diff of this file, which the note is written on. */
  rows: ReadonlyArray<DiffRow>;
  /** The head commit of the revision's diff. */
  revisionHead: string;
  revision: number;
  note: DiffAnnotation;
  index: number;
  composing: boolean;
}) {
  const compose = useReviewCommentsStore((state) => state.compose);
  const point = notePoint(note);
  const start = useMutation({
    // Read again on every click: the Files tab's copy never goes stale on its own.
    mutationFn: () => getPullRequestFiles(pr.key, pr.accountId),
    onSuccess: (files) => {
      const written = capture(rows, { path, start: point, end: point }, revisionHead);
      const placed = written && place(written, files);
      if (placed === null || placed._tag === "outdated")
        toastManager.add({ type: "warning", ...NOTE_LOST[placed?.why ?? "lines"] });
      else
        compose({
          key: pr.key,
          path,
          range: { start: point, end: point },
          note: {
            ref: { revision, path, index },
            text: note.text,
            movedTo: placed._tag === "moved" ? placed.placement.anchor : null,
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
            : `Add as comment, ${note.tone} on ${rangeLabel({ start: point, end: point })}`
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
