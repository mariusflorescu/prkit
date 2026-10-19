import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { drawnRanges } from "~/components/diff/lineKeys";
import { readingLine } from "~/components/diff/readingLine";

import { useAskedLines } from "./askStore";
import type { AskTarget } from "./askTarget";

/** Room left between the lines and the dock, or the header they would pass under. */
const GAP = 8;

/**
 * Keeps the lines the dock asks about in view when the dock grows over the guide, as it does
 * when it opens: where they were if they still clear it, else scrolled up just enough that
 * they do, or, when they are taller than the room left, until their first line meets the
 * header. Lines the reader had scrolled out of view stay where they are. The dock's page holds
 * the guide it covers, so the lines are looked for there.
 */
export function useKeepAskedLines(dock: RefObject<HTMLElement | null>, target: AskTarget) {
  const lines = useAskedLines(target.key, target.revision);
  const asked = useRef(lines);
  useLayoutEffect(() => {
    asked.current = lines;
  });
  useEffect(() => {
    const element = dock.current;
    if (element === null) return;
    let height = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grown = element.offsetHeight - height;
      height = element.offsetHeight;
      const range = asked.current;
      if (grown <= 0 || range === null || element.parentElement === null) return;
      const floor = element.getBoundingClientRect().top;
      for (const box of drawnRanges(element.parentElement, range.path, range)) {
        const line = readingLine(box.card);
        // Out of view before the dock grew: above the reading line or under the dock's old top.
        if (line === null || box.bottom <= line.top || box.top >= floor + grown) continue;
        const under = box.bottom + GAP - floor;
        const room = box.top - GAP - line.top;
        if (under > 0)
          line.scroller.scrollBy({ top: Math.min(under, Math.max(room, 0)), behavior: "instant" });
        return;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [dock]);
}
