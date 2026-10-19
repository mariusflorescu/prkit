import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** What a question is about, as a small chip; `remove` makes it removable and names what that does. */
export function ScopeChip({
  label,
  remove,
}: {
  label: string;
  remove?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <span className="inline-flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-0.5 rounded-md border border-border bg-background pr-0.5 pl-2 text-xs text-muted-foreground">
      <span className="truncate" title={label}>
        {label}
      </span>
      {remove === undefined ? (
        <span className="w-1.5" />
      ) : (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={remove.label}
          onClick={remove.onClick}
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}
