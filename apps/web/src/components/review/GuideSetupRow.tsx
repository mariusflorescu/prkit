import type { ReactNode } from "react";

/** One line of the guide setup: a quiet label, then its choices. */
export function GuideSetupRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3 py-1">
      <span className="flex h-6 w-16 shrink-0 items-center text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">{children}</div>
    </div>
  );
}
