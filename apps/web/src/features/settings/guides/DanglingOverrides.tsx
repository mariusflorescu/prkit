import { TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** Overrides whose item was deleted further up. They do nothing until removed. */
export function DanglingOverrides({
  ids,
  noun,
  onRemove,
  disabled,
}: {
  ids: ReadonlyArray<string>;
  noun: string;
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  if (ids.length === 0) return null;
  return (
    <ul aria-label={`Overrides for deleted ${noun}`} className="space-y-1">
      {ids.map((id) => (
        <li
          key={id}
          role="status"
          className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning-surface px-2.5 py-1.5 text-xs text-warning-foreground"
        >
          <span className="flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
            This scope switches a {noun.replace(/s$/, "")} that was deleted, so it does nothing.
          </span>
          <Button size="micro" variant="outline" disabled={disabled} onClick={() => onRemove(id)}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}
