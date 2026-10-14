import {
  type AgentCatalog,
  type AgentProviderKind,
  findAgentModel,
  modelOptionsLabel,
} from "@prkit/contracts";

/** What a review or selection runs on, for the status bar: "Claude Opus 5.5 · High". */
export const agentLabel = (
  catalog: AgentCatalog | undefined,
  agent: {
    readonly provider: AgentProviderKind;
    readonly model: string | null;
    readonly options: Parameters<typeof modelOptionsLabel>[1];
  },
) => {
  const provider = catalog?.providers.find((entry) => entry.kind === agent.provider);
  const providerLabel = provider?.label ?? (agent.provider === "claude" ? "Claude" : "Codex");
  if (agent.model === null) return `${providerLabel} · its default model`;
  const model =
    catalog === undefined ? undefined : findAgentModel(catalog, agent.provider, agent.model);
  if (model === undefined) return `${providerLabel} · ${agent.model}`;
  const traits = modelOptionsLabel(model.options, agent.options);
  const name = model.name.startsWith(providerLabel) ? model.name : `${providerLabel} ${model.name}`;
  return traits === "" ? name : `${name} · ${traits}`;
};
