import type { ReactNode } from "react";

import "./collapsingHeader.css";

/**
 * The sticky part of a page whose full header scrolls away: the row that always
 * stays (the PR view's tabs, the Inbox's filters), and above it a slot for a compact
 * header that fades in once the full one is gone. The scroll container sets
 * `--collapse-compact-height` (the slot) and `--collapse-pinned-height` (all of it).
 * Anything inside marked `data-collapse-compact` shows only while collapsed.
 */
export function CollapsingPinned({
  collapsed,
  compact,
  children,
}: {
  collapsed: boolean;
  compact?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-collapse-pinned="" data-collapsed={collapsed}>
      <div data-collapse-motion="">
        <div data-collapse-slot="">{compact}</div>
        {children}
      </div>
    </div>
  );
}
