import {
  type AccountId,
  type DiffRow,
  type HeadDiff,
  type NoteComment,
  type NoteKey,
  noteKey,
  notePoint,
  place,
  type PullRequestKey,
} from "@prkit/contracts";

import type { DiffAnnotation } from "~/components/diff";
import { NoteCommentButton } from "./NoteCommentButton";
import { NoteCommentStatus } from "./NoteCommentStatus";
import { COMMENTABLE } from "./reviewCommentPresentation";

/** Under a question or risk note: what became of the draft it made, or the way to make one. */
export function NoteCommentFooter({
  pr,
  path,
  rows,
  diff,
  revision,
  note,
  index,
  fromNotes,
  composing,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  path: string;
  /** The rows of the revision's diff of this file, which the note is written on. */
  rows: ReadonlyArray<DiffRow>;
  /** The revision's diff of this file, at the revision's head. */
  diff: HeadDiff;
  revision: number;
  note: DiffAnnotation;
  index: number;
  fromNotes: ReadonlyMap<NoteKey, NoteComment>;
  composing: boolean;
}) {
  if (!COMMENTABLE[note.tone]) return null;
  const key = noteKey(path, rows, note);
  const comment = key === null ? undefined : fromNotes.get(key);
  if (comment === undefined)
    return (
      <NoteCommentButton
        pr={pr}
        path={path}
        rows={rows}
        revisionHead={diff.headSha}
        revision={revision}
        note={note}
        index={index}
        composing={composing}
      />
    );
  const point = notePoint(note);
  const { end } = comment.anchor;
  return (
    <NoteCommentStatus
      comment={comment}
      underNote={
        end.side === point.side && end.line === point.line && place(comment, diff)._tag === "kept"
      }
    />
  );
}
