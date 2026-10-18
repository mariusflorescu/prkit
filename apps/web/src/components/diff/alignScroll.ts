export type ScrollTarget = () => {
  readonly element: Element;
  readonly block: ScrollLogicalPosition;
  readonly focus: HTMLElement;
} | null;

const STOPPERS = ["wheel", "touchstart", "keydown", "mousedown"] as const;

/** Only one alignment runs at a time, so a later jump never fights an earlier one. */
let active: (() => void) | null = null;

/**
 * Scrolls `target` into place and keeps it there for three seconds while deferred diffs
 * inside `content` replace their estimated heights. The user's wheel, touch, key or mouse
 * press in `viewport` stops it early.
 */
export function alignScroll(viewport: HTMLElement, content: Element | null, target: ScrollTarget) {
  active?.();
  let aligning = true;
  const realign = () => {
    const found = aligning ? target() : null;
    found?.element.scrollIntoView({ block: found.block, behavior: "instant" });
  };
  const observer = new ResizeObserver(realign);
  const stop = () => {
    aligning = false;
    observer.disconnect();
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(frame);
    for (const event of STOPPERS) viewport.removeEventListener(event, stop);
    if (active === stop) active = null;
  };
  const timeout = window.setTimeout(stop, 3000);
  const frame = window.requestAnimationFrame(() => {
    if (content) observer.observe(content);
    realign();
    target()?.focus.focus({ preventScroll: true });
  });
  for (const event of STOPPERS) viewport.addEventListener(event, stop, { passive: true });
  active = stop;
  return { realign, stop };
}

/** The nearest ancestor that scrolls vertically. */
export function scrollParent(element: Element) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}
