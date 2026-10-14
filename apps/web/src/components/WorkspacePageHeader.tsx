import type { ReactNode } from "react";

import { desktopBridge } from "~/lib/desktop";
import { cn } from "~/lib/utils";

/** The 52px top bar of the main area. In Electron it doubles as the window's drag handle. */
export function WorkspacePageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header
      className={cn(
        "flex h-(--workspace-topbar-height) shrink-0 items-center gap-3 border-b border-border pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        desktopBridge && "drag-region",
      )}
    >
      <h1 className="min-w-0 truncate font-medium text-foreground text-sm">{title}</h1>
      {children}
    </header>
  );
}
