import type { AgentCatalogEntry } from "@prkit/contracts";

import { instanceInitials } from "./agentSelection";

/**
 * Tells two setups of one agent apart: the instance's initials, after a dot in the user's own
 * accent when it has one. The accent is the one color prkit takes from the user.
 */
export function InstanceMarker({ entry }: { entry: Pick<AgentCatalogEntry, "label" | "accent"> }) {
  return (
    <span
      title={entry.label}
      className="inline-flex h-4 shrink-0 items-center gap-1 rounded-sm border border-border px-1 font-mono text-2xs leading-none text-muted-foreground"
    >
      {entry.accent !== null && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full"
          style={{ backgroundColor: entry.accent }}
        />
      )}
      {instanceInitials(entry.label)}
    </span>
  );
}
