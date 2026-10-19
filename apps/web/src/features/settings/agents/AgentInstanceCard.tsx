import type { AgentCatalog, AgentCatalogEntry } from "@prkit/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { showsInstance } from "~/components/review/agent/agentSelection";
import { InstanceMarker } from "~/components/review/agent/InstanceMarker";
import { ProviderIcon } from "~/components/review/agent/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";

import { AgentInstanceEditor } from "./AgentInstanceEditor";
import { AgentSignInHelp } from "./AgentSignInHelp";
import { agentStatus, type AgentStatusTone } from "./agentStatus";
import { configOf } from "./instanceConfig";
import { RemoveAgentDialog } from "./RemoveAgentDialog";
import { ResetAgentDialog } from "./ResetAgentDialog";
import { useAgentInstanceActions } from "./useAgentInstanceActions";

const TONES: Record<AgentStatusTone, string> = {
  ready: "text-xs text-success-foreground",
  off: "text-xs text-muted-foreground",
  problem: "text-xs text-error-foreground",
  checking: "text-xs text-muted-foreground",
};

/**
 * One agent instance: its mark, name and version, whether it's on, its sign-in status with what
 * fixes it, and its actions. A default instance can be reset, an added one removed.
 */
export function AgentInstanceCard({
  entry,
  catalog,
  checkingAll,
}: {
  entry: AgentCatalogEntry;
  catalog: AgentCatalog;
  checkingAll: boolean;
}) {
  const actions = useAgentInstanceActions();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const checking =
    checkingAll || (actions.check.isPending && actions.check.variables === entry.instance);
  const status = agentStatus(entry, checking);
  const busy = actions.toggle.isPending;
  return (
    <li
      aria-label={entry.label}
      data-instance={entry.instance}
      className="flex items-start gap-3 border-b border-border/60 py-4"
    >
      <ProviderIcon kind={entry.kind} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{entry.label}</span>
          {showsInstance(catalog, entry) && <InstanceMarker entry={entry} />}
          {!entry.isDefault && (
            <span className="font-mono text-2xs text-muted-foreground">{entry.instance}</span>
          )}
          {entry.version !== null && (
            <span className="text-2xs tabular-nums text-muted-foreground">v{entry.version}</span>
          )}
        </div>
        <p role="status" aria-label={`${entry.label} status`} className={TONES[status.tone]}>
          {status.headline}
        </p>
        {status.detail !== null && <p className="text-xs text-muted-foreground">{status.detail}</p>}
        {!checking && <AgentSignInHelp entry={entry} />}
        {entry.configDir !== null && (
          <p className="break-all font-mono text-2xs text-muted-foreground">{entry.configDir}</p>
        )}
        {!editing && (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Button size="xs" variant="ghost-muted" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {entry.isDefault ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => setResetting(true)}
              >
                Reset to default
              </Button>
            ) : (
              <Button size="xs" variant="ghost-destructive" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            )}
          </div>
        )}
        {editing && <AgentInstanceEditor entry={entry} onDone={() => setEditing(false)} />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={`Check ${entry.label} again`}
          disabled={checking || !entry.enabled}
          onClick={() => actions.check.mutate(entry.instance)}
        >
          <RefreshCwIcon />
        </Button>
        <Switch
          aria-label={`${entry.label} on`}
          checked={busy ? (actions.toggle.variables?.enabled ?? entry.enabled) : entry.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => actions.toggle.mutate({ ...configOf(entry), enabled })}
        />
      </div>
      {entry.isDefault ? (
        <ResetAgentDialog entry={entry} open={resetting} onOpenChange={setResetting} />
      ) : (
        <RemoveAgentDialog entry={entry} open={removing} onOpenChange={setRemoving} />
      )}
    </li>
  );
}
