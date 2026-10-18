import { type RefObject, useEffect } from "react";

import { sectionsInView } from "./readingLine";

const toggleOf = (section: Element) =>
  section.querySelector<HTMLElement>(
    section.matches("[data-file-diff-card]")
      ? "[data-file-diff-meta] [data-reviewed-toggle]"
      : "[data-chapter-meta] [data-reviewed-toggle]",
  );

/** One a tick would change: not reviewed yet, and prkit can tell its version. */
const markable = (section: Element) => {
  const state = toggleOf(section)?.dataset.state;
  return state !== undefined && state !== "reviewed" && state !== "unknown";
};

/**
 * `r` ticks or unticks Reviewed by clicking the checkbox itself, so the key and the mouse
 * save and fold the same way. The file or chapter holding focus goes first; without one,
 * the first of `selector` in view still to review, so pressing `r` again moves on to the
 * next one instead of unticking the one it just folded.
 */
export function useReviewedKey(rootRef: RefObject<HTMLElement | null>, selector: string | null) {
  useEffect(() => {
    if (selector === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "r" ||
        event.repeat ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      // The diffs draw in shadow roots, where the event's target is only the host.
      const origin = event.composedPath()[0];
      if (
        origin instanceof HTMLElement &&
        (origin.matches("input, textarea, select") || origin.isContentEditable)
      )
        return;
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof HTMLElement)) return;
      if (target !== document.body && !root.contains(target)) return;
      const focused = target.closest("[data-file-diff-card], [data-guide-chapter]");
      const section =
        focused !== null && root.contains(focused)
          ? focused
          : (sectionsInView(root, selector).find(markable) ?? null);
      const toggle =
        section === null
          ? null
          : toggleOf(section)?.querySelector<HTMLElement>("[role='checkbox']");
      if (toggle === null || toggle === undefined) return;
      event.preventDefault();
      toggle.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef, selector]);
}
