import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Whether a page's full header has scrolled out of `scroll`. Put `sentinel` at the
 * bottom of the header's title: it collapses once that leaves the top, and expands
 * again only when the title is 8px back in view, so a pixel of scroll at the edge
 * doesn't flicker it.
 */
export const useCollapsingHeader = (scroll: RefObject<HTMLElement | null>) => {
  const sentinel = useRef<HTMLSpanElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const root = scroll.current;
    const title = sentinel.current;
    if (!root || !title) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) setCollapsed(false);
        else if (entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0)) setCollapsed(true);
      },
      { root, rootMargin: collapsed ? "-8px 0px 0px 0px" : "0px", threshold: 0 },
    );
    observer.observe(title);
    return () => observer.disconnect();
  }, [collapsed, scroll]);
  return { collapsed, sentinel };
};
