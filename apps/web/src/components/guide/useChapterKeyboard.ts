import { useEffect, type RefObject } from "react";

import { readingPosition } from "./readingPosition";

export function useChapterKeyboard(
  viewportRef: RefObject<HTMLDivElement | null>,
  onChapter: (id: string) => void,
  pinned: string | null,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.key !== "j" && event.key !== "k")
      )
        return;
      // The diffs draw in shadow roots, where the event's target is only the host.
      const origin = event.composedPath()[0];
      if (
        origin instanceof HTMLElement &&
        (origin.matches("input, textarea, select") || origin.isContentEditable)
      )
        return;
      const viewport = viewportRef.current;
      if (
        !viewport ||
        (event.target instanceof HTMLElement &&
          event.target !== document.body &&
          !viewport.contains(event.target))
      )
        return;
      const position = readingPosition(viewport, pinned);
      if (position === null) return;
      const { chapters, index, aligned } = position;
      const next = event.key === "j" ? index + 1 : aligned ? index - 1 : index;
      const target = chapters[next]?.dataset.chapterId;
      if (target) {
        event.preventDefault();
        onChapter(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewportRef, onChapter, pinned]);
}
