import { type RefObject, useLayoutEffect, useState } from "react";

import { readingLine } from "~/components/diff/readingLine";

import { readingPosition } from "./readingPosition";

/**
 * The id of the chapter being read, null in the overview, for the guide that holds `railRef`.
 * It lives in the caller's state, so scrolling re-renders only the rail. Measured once per
 * frame after a scroll, after the guide resizes (folding a chapter moves the rest) and when
 * the pin changes. It starts from the rail because a parent's ref is not set yet when a child
 * lays out for the first time.
 */
export function useReadingChapter(railRef: RefObject<HTMLElement | null>, pinned: string | null) {
  const [current, setCurrent] = useState<string | null>(null);
  useLayoutEffect(() => {
    const viewport = railRef.current?.closest<HTMLElement>("[data-guide-scroll]");
    const scroller = viewport && readingLine(viewport)?.scroller;
    if (!viewport || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const position = readingPosition(viewport, pinned);
      setCurrent(position?.chapters[position.index]?.dataset.chapterId ?? null);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    const content = viewport.querySelector("[data-guide-content]");
    if (content) observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [railRef, pinned]);
  return current;
}
