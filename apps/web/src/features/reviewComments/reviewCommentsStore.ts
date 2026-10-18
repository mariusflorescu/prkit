import type { CommentAnchor, NoteRef, PullRequestKey, ReviewCommentId } from "@prkit/contracts";
import { create } from "zustand";

import type { LineRange } from "~/components/diff";

/** Where a guide note is shown: its revision's own diff on the Guide, or GitHub's diff on Files. */
export type NoteSurface = "guide" | "files";
/**
 * A comment started from a guide note, and where its line is now if the code moved. `on` is
 * the surface whose line numbers the composer's range uses.
 */
export type NoteDraft = {
  ref: NoteRef;
  text: string;
  on: NoteSurface;
  movedTo: CommentAnchor | null;
};
/** Where a new comment is being written; one composer at a time, like GitHub. */
type Composer = { key: PullRequestKey; path: string; range: LineRange; note: NoteDraft | null };
/** An outdated draft waiting for the user to pick its new line in the same file. */
type Moving = { key: PullRequestKey; path: string; id: ReviewCommentId };

export const useReviewCommentsStore = create<{
  composer: Composer | null;
  moving: Moving | null;
  /** Inline edits and replies open per PR, besides the composer. */
  forms: Partial<Record<PullRequestKey, number>>;
  compose: (composer: Composer) => void;
  closeComposer: () => void;
  startMove: (moving: Moving) => void;
  stopMove: () => void;
  openForm: (key: PullRequestKey) => void;
  closeForm: (key: PullRequestKey) => void;
}>((set) => ({
  composer: null,
  moving: null,
  forms: {},
  compose: (composer) => set({ composer, moving: null }),
  closeComposer: () => set({ composer: null }),
  startMove: (moving) => set({ moving, composer: null }),
  stopMove: () => set({ moving: null }),
  openForm: (key) =>
    set((state) => ({ forms: { ...state.forms, [key]: (state.forms[key] ?? 0) + 1 } })),
  closeForm: (key) =>
    set((state) => ({
      forms: { ...state.forms, [key]: Math.max(0, (state.forms[key] ?? 0) - 1) },
    })),
}));

/** Whether words are being written in a form inside a PR's diffs: a new comment, an edit or a reply. */
export const writingOn =
  (key: PullRequestKey) => (state: ReturnType<typeof useReviewCommentsStore.getState>) =>
    state.composer?.key === key || (state.forms[key] ?? 0) > 0;
