import type { PullRequestKey } from "@prkit/contracts";
import { useEffect } from "react";

import { type NoteSurface, useReviewCommentsStore } from "./reviewCommentsStore";

/**
 * The revision a surface keeps on screen while one of its note composers is open, so a
 * revision accepted meanwhile doesn't remount the diff and take the words. Leaving the
 * surface closes that composer: its words go with the surface, and the hold would protect
 * nothing.
 */
export function useNoteComposerHold(key: PullRequestKey, on: NoteSurface) {
  const held = useReviewCommentsStore((state) =>
    state.composer?.key === key && state.composer.note?.on === on
      ? state.composer.note.ref.revision
      : null,
  );
  const closeComposer = useReviewCommentsStore((state) => state.closeComposer);
  useEffect(
    () => () => {
      const { composer } = useReviewCommentsStore.getState();
      if (composer?.key === key && composer.note?.on === on) closeComposer();
    },
    [key, on, closeComposer],
  );
  return held;
}
