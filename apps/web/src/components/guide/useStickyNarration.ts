import { useEffect, useRef } from "react";

export function useStickyNarration() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const viewport =
      element.closest<HTMLElement>("[data-pr-scroll]") ??
      element.closest<HTMLElement>("[data-guide-scroll]");
    const fit = () => {
      const pinned = viewport?.hasAttribute("data-pr-scroll")
        ? Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--pr-pinned-height"))
        : 0;
      element.style.top = `${Math.round(pinned + Math.min(24, (viewport?.clientHeight ?? window.innerHeight) - pinned - element.offsetHeight - 24))}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    if (viewport) observer.observe(viewport);
    fit();
    return () => observer.disconnect();
  }, []);
  return ref;
}
