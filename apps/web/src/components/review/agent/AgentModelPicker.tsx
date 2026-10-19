import {
  type AgentCatalog,
  type AgentSelection,
  findAgentEntry,
  findAgentModel,
  keepModelOptions,
} from "@prkit/contracts";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Fragment } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { ComboboxFooter, ComboboxStatus } from "~/components/ui/combobox";
import { SearchPicker } from "~/components/ui/search-picker";

import { AgentSignIn } from "./AgentSignIn";
import { showsInstance } from "./agentSelection";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { type ModelItem, ModelListRow, modelBlockedReason } from "./ModelListRow";
import { ProviderGroupLabel } from "./ProviderGroupLabel";
import { InstanceMarker } from "./InstanceMarker";
import { ProviderIcon } from "./ProviderIcon";

const itemKey = (instance: string, slug: string) => `${instance}:${slug}`;

/**
 * Picks the agent and model: the agent's icon and model name, then a searchable list grouped
 * by agent instance with the login each one uses. Instances that are turned off stay out.
 * Switching models keeps the settings the new model also takes.
 */
export function AgentModelPicker({
  catalog,
  value,
  onChange,
  onCheckAgain,
  checking,
  disabled = false,
  size = "sm",
}: {
  catalog: AgentCatalog;
  value: AgentSelection | null;
  onChange: (selection: AgentSelection) => void;
  onCheckAgain: () => void;
  checking: boolean;
  disabled?: boolean;
  size?: ComposerControlSize;
}) {
  const enabled = catalog.providers.filter((provider) => provider.enabled);
  const groups = enabled.map((provider) => ({
    value: provider.instance,
    label: <ProviderGroupLabel provider={provider} catalog={catalog} />,
    items: provider.models.map((model): ModelItem => ({
      key: itemKey(provider.instance, model.slug),
      provider,
      model,
    })),
  }));
  const selected =
    value === null
      ? null
      : (groups
          .flatMap((group) => group.items)
          .find((item) => item.key === itemKey(value.instance, value.model)) ?? null);
  const model = value === null ? undefined : findAgentModel(catalog, value.instance, value.model);
  const entry = value === null ? undefined : findAgentEntry(catalog, value.instance);
  const marked = entry !== undefined && showsInstance(catalog, entry);
  const label = `${model?.name ?? value?.model ?? "Choose a model"}${marked ? ` · ${entry.label}` : ""}`;
  // An instance that isn't ready lists no models, so the list has no group to say why.
  const notReady = enabled.filter(
    (provider) => provider.state._tag === "unavailable" && provider.models.length === 0,
  );
  return (
    <SearchPicker
      trigger={<ComposerControl size={size} aria-label={`Agent and model: ${label}`} />}
      groups={groups}
      value={selected}
      itemKey={(item) => item.key}
      itemText={(item) =>
        `${item.model.name} ${item.model.slug} ${item.provider.label} ${item.provider.instance}`
      }
      renderItem={(item) => <ModelListRow item={item} />}
      itemDisabled={(item) => modelBlockedReason(item) !== null}
      itemTitle={(item) => modelBlockedReason(item) ?? item.model.description ?? undefined}
      onSelect={(item) =>
        onChange({
          instance: item.provider.instance,
          model: item.model.slug,
          options: keepModelOptions(item.model.options, value?.options ?? []),
        })
      }
      searchLabel="Search models"
      empty={(query) => `No models match “${query}”`}
      status={notReady.map((provider) => (
        <Fragment key={provider.instance}>
          <ComboboxStatus role="status" aria-label={`${provider.label} isn't ready`}>
            <ProviderGroupLabel provider={provider} catalog={catalog} />
          </ComboboxStatus>
          {provider.state._tag === "unavailable" && provider.state.reason === "keychain-login" && (
            <div className="px-3 pb-1.5">
              <AgentSignIn instance={provider.instance} />
            </div>
          )}
        </Fragment>
      ))}
      footer={
        <ComboboxFooter>
          <Button variant="ghost-muted" size="micro" disabled={checking} onClick={onCheckAgain}>
            <ButtonLabel
              icon={<RefreshCwIcon />}
              shown={checking ? "checking" : "check"}
              labels={{ check: "Check again", checking: "Checking…" }}
            />
          </Button>
        </ComboboxFooter>
      }
      disabled={disabled}
    >
      {entry !== undefined && (
        <ProviderIcon kind={entry.kind} className={size === "xs" ? "size-3.5" : "size-4"} />
      )}
      {marked && <InstanceMarker entry={entry} />}
      <span className="min-w-0 truncate">{model?.name ?? value?.model ?? "Choose a model"}</span>
      <ChevronDownIcon
        aria-hidden="true"
        className={size === "xs" ? "size-3 opacity-50" : "size-3.5 opacity-60"}
      />
    </SearchPicker>
  );
}
