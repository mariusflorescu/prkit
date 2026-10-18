import { type RefObject, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * `/` asks for the tree's filter: `reveal` shows the tree if it was hidden, and the
 * returned counter goes up so the panel focuses its field. The tree is on screen before
 * the counter moves, so a panel that mounts for the key still sees the change.
 */
export function useFilterKey(rootRef: RefObject<HTMLElement | null>, reveal: () => void) {
  const [request, setRequest] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
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
      event.preventDefault();
      flushSync(reveal);
      setRequest((count) => count + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef, reveal]);
  return request;
}
