import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * A button's words when they change with what it is doing: Save, Saving…, Retry. The button is
 * as wide as the longest of them all along, so nothing beside it moves when the words change.
 * Only the shown words are painted and read out. An icon goes in `icon`, so it stays beside
 * whichever words show instead of across the room kept for the longest.
 */
export function ButtonLabel<Key extends string>({
  labels,
  shown,
  icon,
}: {
  labels: Readonly<Record<Key, string>>;
  shown: NoInfer<Key>;
  icon?: React.ReactNode;
}) {
  return (
    <span data-slot="button-label" className="grid justify-items-center [gap:inherit]">
      {Object.entries<string>(labels).map(([key, label]) => (
        <span
          key={key}
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center [gap:inherit]",
            key !== shown && "invisible",
          )}
        >
          {icon}
          {label}
        </span>
      ))}
    </span>
  );
}
