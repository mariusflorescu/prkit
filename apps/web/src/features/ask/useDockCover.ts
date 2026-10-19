import { type RefObject, useLayoutEffect } from "react";

/**
 * Tells a pull request's scroller how much of its foot the dock covers (`--pr-covered-bottom`),
 * whatever height the dock has, so what scrolls into view in the guide stops above it. A local
 * guide's dock sits under its scroller and covers nothing.
 */
export function useDockCover(dock: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = dock.current;
    const scroller = element?.closest<HTMLElement>("[data-pr-scroll]");
    if (!element || !scroller) return;
    const cover = () =>
      scroller.style.setProperty("--pr-covered-bottom", `${element.offsetHeight}px`);
    cover();
    const observer = new ResizeObserver(cover);
    observer.observe(element);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty("--pr-covered-bottom");
    };
  }, [dock]);
}
