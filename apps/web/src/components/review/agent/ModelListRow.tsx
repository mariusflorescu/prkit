import type { AgentCatalogEntry, AgentModel } from "@prkit/contracts";

export interface ModelItem {
  readonly key: string;
  readonly provider: AgentCatalogEntry;
  readonly model: AgentModel;
}

/** Why a model can't run here: its provider isn't ready, or the model is blocked. */
export const modelBlockedReason = (item: ModelItem) =>
  item.provider.state._tag === "unavailable" ? item.provider.state.message : item.model.blocked;

/** One model on one line: its name, its description cut to fit, and whether it is the default. */
export function ModelListRow({ item }: { item: ModelItem }) {
  const note = item.model.blocked ?? item.model.description;
  return (
    <>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 font-medium">{item.model.name}</span>
        {note !== null && <span className="truncate text-2xs text-muted-foreground">{note}</span>}
      </span>
      {item.model.isDefault && (
        <span className="shrink-0 text-2xs text-muted-foreground">Default</span>
      )}
    </>
  );
}
