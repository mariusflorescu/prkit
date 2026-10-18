import { type RefObject, useEffect, useState } from "react";

import { readingLine } from "~/components/diff/readingLine";

/**
 * The chapter the reader last jumped to. It only matters while the guide ends before that
 * chapter can reach the reading line (see `readingPosition`), and it lasts until the reader
 * scrolls by hand: wheel, touch, a press on the scroller (its scrollbar too), or any key but
 * the ones that jump (j, k) or tick (r). A key the rail or a button already handled is not a scroll.
 */
export function useReadingPin(viewportRef: RefObject<HTMLElement | null>) {
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    const scroller = viewport && readingLine(viewport)?.scroller;
    if (pinned === null || !scroller) return;
    const clear = () => setPinned(null);
    const onKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key !== "j" && event.key !== "k" && event.key !== "r")
        clear();
    };
    scroller.addEventListener("wheel", clear, { passive: true });
    scroller.addEventListener("touchstart", clear, { passive: true });
    scroller.addEventListener("pointerdown", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      scroller.removeEventListener("wheel", clear);
      scroller.removeEventListener("touchstart", clear);
      scroller.removeEventListener("pointerdown", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, [viewportRef, pinned]);
  return [pinned, setPinned] as const;
}
