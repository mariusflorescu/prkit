import {
  type AccountId,
  type NoteComment,
  type NoteKey,
  noteKey,
  place,
  type PullRequestKey,
} from "@prkit/contracts";

import { NoteCommentButton } from "./NoteCommentButton";
import { NoteCommentStatus } from "./NoteCommentStatus";
import { COMMENTABLE } from "./reviewCommentPresentation";
import { samePoint, type ShownNote } from "./shownNote";

/** Under a question or risk note: what became of the draft it made, or the way to make one. */
export function NoteCommentFooter({
  pr,
  note,
  fromNotes,
  composing,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  note: ShownNote;
  fromNotes: ReadonlyMap<NoteKey, NoteComment>;
  /** The remarks whose comment is being written on this diff. */
  composing: ReadonlySet<NoteKey>;
}) {
  if (!COMMENTABLE[note.written.tone]) return null;
  const key = noteKey(note.ref.path, note.writtenRows, note.written);
  const comment = key === null ? undefined : fromNotes.get(key);
  if (comment === undefined)
    return (
      <NoteCommentButton
        pr={pr}
        note={note}
        noteKey={key}
        composing={key !== null && composing.has(key)}
      />
    );
  const placed = place(comment, note.rows, note.head);
  // Files shows GitHub's diff at the head, where a draft that no longer reads the same is outdated.
  const where =
    placed._tag !== "outdated" && samePoint(placed.placement.anchor.end, note.at)
      ? "under"
      : placed._tag === "outdated" && note.on === "files"
        ? "outdated"
        : "elsewhere";
  return <NoteCommentStatus comment={comment} place={where} />;
}
