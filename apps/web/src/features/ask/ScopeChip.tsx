import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** What a question is about, as a small chip; `onRemove` makes it removable. */
export function ScopeChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-0.5 rounded-md border border-border bg-background pr-0.5 pl-2 text-xs text-muted-foreground">
      <span className="truncate" title={label}>
        {label}
      </span>
      {onRemove === undefined ? (
        <span className="w-1.5" />
      ) : (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Ask about the whole PR instead"
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}
