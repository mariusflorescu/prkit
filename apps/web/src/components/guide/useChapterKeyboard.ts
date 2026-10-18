import { useEffect, type RefObject } from "react";

import { readingLine } from "~/components/diff/readingLine";

export function useChapterKeyboard(
  viewportRef: RefObject<HTMLDivElement | null>,
  onChapter: (id: string) => void,
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
      if (
        event.target instanceof HTMLElement &&
        (event.target.matches("input, textarea, select") || event.target.isContentEditable)
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
      const line = readingLine(viewport);
      if (line === null) return;
      // A chapter scrolled to sits its scroll margin below the reading line.
      const top = line.top + 16;
      const chapters = Array.from(viewport.querySelectorAll<HTMLElement>("[data-guide-chapter]"));
      const target =
        event.key === "j"
          ? chapters.find((chapter) => chapter.getBoundingClientRect().top > top + 4)
          : chapters.findLast((chapter) => chapter.getBoundingClientRect().top < top - 4);
      if (target?.dataset.chapterId) {
        event.preventDefault();
        onChapter(target.dataset.chapterId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewportRef, onChapter]);
}
