import { Button } from "~/components/ui/button";

import { isConflict } from "./useSaveGuideSection";

/** A refused save: a stale form reloads, anything else can be tried again. */
export function SaveProblem({
  error,
  onRetry,
  onReload,
}: {
  error: Error;
  onRetry: () => void;
  onReload: () => void;
}) {
  const conflict = isConflict(error);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-error/30 bg-error-surface px-3 py-2 text-xs text-error-foreground"
    >
      <p>{error.message}</p>
      <Button size="compact" variant="outline" onClick={conflict ? onReload : onRetry}>
        {conflict ? "Reload" : "Retry"}
      </Button>
    </div>
  );
}
