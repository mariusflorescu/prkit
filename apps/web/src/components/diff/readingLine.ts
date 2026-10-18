/**
 * The scroll container an element reads in, and the lines that bound what is being read:
 * `top` is just under its pinned header (the PR view pins its title and tab row over the
 * content, a lone guide pins nothing), `bottom` just above whatever covers its foot
 * (`--pr-covered-bottom`, such as a dock).
 */
export const readingLine = (
  element: Element,
): { readonly scroller: HTMLElement; readonly top: number; readonly bottom: number } | null => {
  const scroller =
    element.closest<HTMLElement>("[data-pr-scroll]") ??
    element.closest<HTMLElement>("[data-guide-scroll]");
  if (scroller === null) return null;
  const style = getComputedStyle(scroller);
  const pinned = scroller.hasAttribute("data-pr-scroll")
    ? Number.parseFloat(style.getPropertyValue("--pr-pinned-height")) || 0
    : 0;
  const covered = Number.parseFloat(style.getPropertyValue("--pr-covered-bottom")) || 0;
  const rect = scroller.getBoundingClientRect();
  return { scroller, top: rect.top + pinned, bottom: rect.bottom - covered };
};

/** Scrolls so the element starts at the reading line, when it starts above it. */
export const alignIfAbove = (element: Element) => {
  const line = readingLine(element);
  if (line === null) return;
  const offset = element.getBoundingClientRect().top - line.top;
  if (offset < 0) line.scroller.scrollBy({ top: offset, behavior: "instant" });
};

/** These sections in view below the reading line, top first. */
export const sectionsInView = (root: HTMLElement, selector: string): HTMLElement[] => {
  const line = readingLine(root);
  if (line === null) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((section) => {
    const rect = section.getBoundingClientRect();
    return rect.bottom > line.top + 1 && rect.top < line.bottom;
  });
};
