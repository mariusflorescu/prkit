import { useEffect, type RefObject } from "react";

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
      const top = viewport.getBoundingClientRect().top + 16;
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
