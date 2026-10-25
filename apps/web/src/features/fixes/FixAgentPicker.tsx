import type { AgentSelection } from "@prkit/contracts";

import { AgentModelPicker } from "~/components/review/agent/AgentModelPicker";
import { ModelTraitsPicker } from "~/components/review/agent/ModelTraitsPicker";

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
  if (agent.catalog === undefined) return null;
  const { selection, model } = agent;
  return (
    <div className="flex min-w-0 items-center gap-1">
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
