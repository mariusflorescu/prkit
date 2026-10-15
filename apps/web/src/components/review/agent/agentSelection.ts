import {
  AGENT_KIND_NAMES,
  type AgentCatalog,
  type AgentCatalogEntry,
  type AgentProviderKind,
  findAgentEntry,
  findAgentModel,
  modelOptionsLabel,
} from "@prkit/contracts";

/**
 * Whether an instance needs its name and marker beside the agent's icon: it has an accent,
 * or another turned-on instance runs the same agent. A lone default instance looks as it
 * always did.
 */
export const showsInstance = (
  catalog: AgentCatalog | undefined,
  entry: Pick<AgentCatalogEntry, "instance" | "kind" | "accent">,
) =>
  entry.accent !== null ||
  (catalog?.providers.filter(
    (candidate) =>
      candidate.kind === entry.kind && (candidate.enabled || candidate.instance === entry.instance),
  ).length ?? 0) > 1;

/** Up to two initials for an instance's marker: "Work" gives "WO", "Side project" gives "SP". */
export const instanceInitials = (label: string) => {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  const [first, second] = words;
  if (first === undefined) return "";
  if (second === undefined) return Array.from(first).slice(0, 2).join("").toUpperCase();
  return `${Array.from(first)[0] ?? ""}${Array.from(second)[0] ?? ""}`.toUpperCase();
};

/**
 * What to call the agent of a review or fix session in a sentence: "Claude", or "Claude (Work)"
 * when another instance of Claude is around. A removed instance still reads as its kind.
 */
export const agentName = (
  catalog: AgentCatalog | undefined,
  agent: { readonly instance: string; readonly provider: AgentProviderKind },
) => {
  const short = AGENT_KIND_NAMES[agent.provider].short;
  const entry = catalog === undefined ? undefined : findAgentEntry(catalog, agent.instance);
  if (entry === undefined || !showsInstance(catalog, entry)) return short;
  return entry.label === short || entry.label === AGENT_KIND_NAMES[agent.provider].name
    ? short
    : `${short} (${entry.label})`;
};

/** What a review or selection runs on, for the status bar: "Claude Opus 5.5 · High", with "· Work" when it's ambiguous. */
export const agentLabel = (
  catalog: AgentCatalog | undefined,
  agent: {
    readonly instance: string;
    readonly provider: AgentProviderKind;
    readonly model: string | null;
    readonly options: Parameters<typeof modelOptionsLabel>[1];
  },
) => {
  const short = AGENT_KIND_NAMES[agent.provider].short;
  const entry = catalog === undefined ? undefined : findAgentEntry(catalog, agent.instance);
  const instance = entry !== undefined && showsInstance(catalog, entry) ? ` · ${entry.label}` : "";
  if (agent.model === null) return `${short} · its default model${instance}`;
  const model =
    catalog === undefined ? undefined : findAgentModel(catalog, agent.instance, agent.model);
  if (model === undefined) return `${short} · ${agent.model}${instance}`;
  const traits = modelOptionsLabel(model.options, agent.options);
  const name = model.name.startsWith(short) ? model.name : `${short} ${model.name}`;
  return `${traits === "" ? name : `${name} · ${traits}`}${instance}`;
};
