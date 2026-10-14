import {
  type AgentCatalog,
  effectiveSelection,
  findAgentModel,
  type GuideSettings,
} from "@prkit/contracts";

import { AgentModelPicker } from "~/components/review/agent/AgentModelPicker";
import { ModelTraitsPicker } from "~/components/review/agent/ModelTraitsPicker";

import { useCheckAgents } from "./useCheckAgents";

/** The agent, model and settings a guide uses when none is picked for it. */
export function DefaultAgentSetting({
  catalog,
  settings,
  onChange,
  saving,
}: {
  catalog: AgentCatalog;
  settings: GuideSettings;
  onChange: (defaultAgent: GuideSettings["defaultAgent"]) => void;
  saving: boolean;
}) {
  const checkAgain = useCheckAgents();
  const selection = effectiveSelection(catalog, settings.defaultAgent) ?? settings.defaultAgent;
  const model =
    selection === null ? undefined : findAgentModel(catalog, selection.provider, selection.model);
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-border/60 py-3">
      <div className="min-w-0">
        <p className="text-sm">Default agent</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The Guide tab starts from it. The inbox, the command palette, Cmd+G and automatic guides
          use it as is.
        </p>
        {checkAgain.error !== null && (
          <p role="alert" className="mt-1 text-xs text-error-foreground">
            {checkAgain.error.message}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <AgentModelPicker
          catalog={catalog}
          value={selection}
          onChange={onChange}
          onCheckAgain={() => checkAgain.mutate()}
          checking={checkAgain.isPending}
          disabled={saving}
        />
        {model !== undefined && selection !== null && (
          <ModelTraitsPicker
            model={model}
            options={selection.options}
            onChange={(options) => onChange({ ...selection, options })}
            disabled={saving}
          />
        )}
      </div>
    </div>
  );
}
