import type { CommentAnchor, NoteRef, PullRequestKey, ReviewCommentId } from "@prkit/contracts";
import { create } from "zustand";

import type { LineRange } from "~/components/diff";

/** A comment started from a guide note, and where its line is now if the code moved. */
export type NoteDraft = { ref: NoteRef; text: string; movedTo: CommentAnchor | null };
/** Where a new comment is being written; one composer at a time, like GitHub. */
type Composer = { key: PullRequestKey; path: string; range: LineRange; note: NoteDraft | null };
/** An outdated draft waiting for the user to pick its new line in the same file. */
type Moving = { key: PullRequestKey; path: string; id: ReviewCommentId };

export const useReviewCommentsStore = create<{
  composer: Composer | null;
  moving: Moving | null;
  compose: (composer: Composer) => void;
  closeComposer: () => void;
  startMove: (moving: Moving) => void;
  stopMove: () => void;
}>((set) => ({
  composer: null,
  moving: null,
  compose: (composer) => set({ composer, moving: null }),
  closeComposer: () => set({ composer: null }),
  startMove: (moving) => set({ moving, composer: null }),
  stopMove: () => set({ moving: null }),
}));
