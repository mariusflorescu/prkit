import type { NoteComment, PendingCommentState } from "@prkit/contracts";
import { CheckIcon } from "lucide-react";

import { rangeLabel } from "./reviewCommentPresentation";

const STATUS = {
  draft: "In your review.",
  "sent-to-agent": "With the agent.",
  published: "Posted on GitHub.",
  "resolved-by-agent": "Fixed by the agent.",
} as const satisfies Record<PendingCommentState, string>;

/** What became of the draft a guide note made. A draft that isn't under the note says where it is. */
export function NoteCommentStatus({
  comment,
  pinned,
}: {
  comment: NoteComment;
  /** Its draft sits under this note in this diff. */
  pinned: boolean;
}) {
  return (
    <p role="status" className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {comment.state === "draft" && !pinned
        ? `In your review, on ${rangeLabel(comment.anchor)} of the latest code.`
        : STATUS[comment.state]}
    </p>
  );
}
