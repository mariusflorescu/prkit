import type { AgentSelection } from "@prkit/contracts";

import { AgentModelPicker } from "~/components/review/agent/AgentModelPicker";
import { ModelTraitsPicker } from "~/components/review/agent/ModelTraitsPicker";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

import type { useFixAgent } from "./useFixAgent";

/** The agent, model and its settings for a fix, the same picker the guide setup uses. */
export function FixAgentPicker({
  agent,
  onChange,
  disabled = false,
}: {
  agent: ReturnType<typeof useFixAgent>;
  onChange: (selection: AgentSelection) => void;
  disabled?: boolean;
}) {
  if (agent.loading)
    return (
      <div
        aria-busy="true"
        aria-label="Loading agents"
        className="flex h-7 items-center gap-4 px-2"
      >
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-16" />
      </div>
    );
  if (agent.error !== null || agent.catalog === undefined)
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-error-foreground">
        <span>{agent.error?.message ?? "Couldn't load the agents."}</span>
        <Button variant="outline" size="compact" onClick={agent.retry}>
          Retry
        </Button>
      </div>
    );
  const { selection, model } = agent;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <AgentModelPicker
        catalog={agent.catalog}
        value={selection}
        onChange={onChange}
        onCheckAgain={() => agent.checkAgain.mutate()}
        checking={agent.checkAgain.isPending}
        disabled={disabled}
      />
      {model !== undefined && selection !== null && (
        <ModelTraitsPicker
          model={model}
          options={selection.options}
          disabled={disabled}
          onChange={(options) => onChange({ ...selection, options })}
        />
      )}
    </div>
  );
}
