import { type AgentCatalog, type AgentSelection, findAgentModel } from "@prkit/contracts";

import { Skeleton } from "~/components/ui/skeleton";

import { AgentModelPicker } from "./agent/AgentModelPicker";
import { ModelTraitsPicker } from "./agent/ModelTraitsPicker";
import { GuideSetupProblem } from "./GuideSetupProblem";

/** Who writes the guide: the agent and model, then the model's own settings, as quiet choices. */
export function GuideSetupAgent({
  catalog,
  loading,
  error,
  onRetry,
  selection,
  onChange,
  onCheckAgain,
  checking,
}: {
  catalog: AgentCatalog | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  selection: AgentSelection | null;
  onChange: (selection: AgentSelection) => void;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  if (loading)
    return (
      <div
        aria-busy="true"
        aria-label="Loading agents"
        className="flex h-6 items-center gap-3 px-1.5"
      >
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  if (error !== null || catalog === undefined)
    return (
      <GuideSetupProblem
        title="Couldn't load the agents"
        message={error?.message ?? "The server sent no agents."}
        onRetry={onRetry}
      />
    );
  const model =
    selection === null ? undefined : findAgentModel(catalog, selection.provider, selection.model);
  return (
    <>
      <AgentModelPicker
        size="xs"
        catalog={catalog}
        value={selection}
        onChange={onChange}
        onCheckAgain={onCheckAgain}
        checking={checking}
      />
      {model !== undefined && selection !== null && (
        <ModelTraitsPicker
          size="xs"
          model={model}
          options={selection.options}
          onChange={(options) => onChange({ ...selection, options })}
        />
      )}
    </>
  );
}
