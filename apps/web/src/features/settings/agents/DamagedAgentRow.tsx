import type { DamagedAgent } from "@prkit/contracts";
import { AlertCircleIcon } from "lucide-react";
import { useState } from "react";

import { ProviderIcon } from "~/components/review/agent/ProviderIcon";
import { Button } from "~/components/ui/button";

import { DamagedAgentDialog } from "./DamagedAgentDialog";
import { damagedAgentLabel } from "./damagedAgentLabel";

/**
 * An agent setting prkit can't read, as its own row among the others: what happened, and Remove
 * (or Reset for a default) as the way out. It has no switch, check or Edit, since nothing of it
 * can be read.
 */
export function DamagedAgentRow({ damaged }: { damaged: DamagedAgent }) {
  const [open, setOpen] = useState(false);
  const label = damagedAgentLabel(damaged);
  return (
    <li
      aria-label={label}
      data-instance={damaged.instance}
      data-damaged=""
      className="flex items-start gap-3 border-b border-border/60 py-4"
    >
      {damaged.kind === null ? (
        <AlertCircleIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      ) : (
        <ProviderIcon kind={damaged.kind} className="mt-0.5 size-5" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <span className="text-sm font-medium">{label}</span>
        <p role="status" aria-label={`${label} status`} className="text-xs text-error-foreground">
          Its setting can't be read
        </p>
        <p className="text-xs text-muted-foreground">{damaged.message}</p>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {damaged.isDefault ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setOpen(true)}>
              Reset to default
            </Button>
          ) : (
            <Button size="xs" variant="ghost-destructive" onClick={() => setOpen(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <DamagedAgentDialog damaged={damaged} open={open} onOpenChange={setOpen} />
    </li>
  );
}
