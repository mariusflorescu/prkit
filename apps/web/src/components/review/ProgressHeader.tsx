import { Button } from "~/components/ui/button";

import { ElapsedTime } from "./ElapsedTime";

/** "Claude is reading this PR", the model it runs, and "3 of 5 files · 14s · Stop". */
export function ProgressHeader({
  title,
  agent,
  label,
  startedAt,
  stopping,
  onStop,
}: {
  title: string;
  agent: string;
  label: string;
  startedAt: string;
  stopping: boolean;
  /** Absent when the page has its own Stop. */
  onStop?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id="guide-progress-title" className="text-sm font-medium">
          {title}
        </h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{agent}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <span data-progress-label="">{label}</span>
        <span aria-hidden="true">·</span>
        <ElapsedTime since={startedAt} />
        {onStop !== undefined && (
          <Button variant="ghost-muted" size="compact" disabled={stopping} onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}
