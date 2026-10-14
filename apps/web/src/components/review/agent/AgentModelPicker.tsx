import {
  type AgentCatalog,
  type AgentSelection,
  findAgentModel,
  keepModelOptions,
} from "@prkit/contracts";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Fragment } from "react";

import { Button } from "~/components/ui/button";
import { ComboboxFooter, ComboboxStatus } from "~/components/ui/combobox";
import { SearchPicker } from "~/components/ui/search-picker";

import { AgentSignIn } from "./AgentSignIn";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { type ModelItem, ModelListRow, modelBlockedReason } from "./ModelListRow";
import { ProviderGroupLabel } from "./ProviderGroupLabel";
import { ProviderIcon } from "./ProviderIcon";

const itemKey = (provider: string, slug: string) => `${provider}:${slug}`;

/**
 * Picks the agent and model: provider icon and model name, then a searchable list
 * grouped by provider with the login each one uses. Switching models keeps the
 * settings the new model also takes.
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
  const groups = catalog.providers.map((provider) => ({
    value: provider.kind,
    label: <ProviderGroupLabel provider={provider} />,
    items: provider.models.map((model): ModelItem => ({
      key: itemKey(provider.kind, model.slug),
      provider,
      model,
    })),
  }));
  const selected =
    value === null
      ? null
      : (groups
          .flatMap((group) => group.items)
          .find((item) => item.key === itemKey(value.provider, value.model)) ?? null);
  const model = value === null ? undefined : findAgentModel(catalog, value.provider, value.model);
  const label = model?.name ?? value?.model ?? "Choose a model";
  // A provider that isn't ready lists no models, so the list has no group to say why.
  const notReady = catalog.providers.filter(
    (provider) => provider.state._tag === "unavailable" && provider.models.length === 0,
  );
  return (
    <SearchPicker
      trigger={<ComposerControl size={size} aria-label={`Agent and model: ${label}`} />}
      groups={groups}
      value={selected}
      itemKey={(item) => item.key}
      itemText={(item) => `${item.model.name} ${item.model.slug} ${item.provider.label}`}
      renderItem={(item) => <ModelListRow item={item} />}
      itemDisabled={(item) => modelBlockedReason(item) !== null}
      itemTitle={(item) => modelBlockedReason(item) ?? item.model.description ?? undefined}
      onSelect={(item) =>
        onChange({
          provider: item.provider.kind,
          model: item.model.slug,
          options: keepModelOptions(item.model.options, value?.options ?? []),
        })
      }
      searchLabel="Search models"
      empty={(query) => `No models match “${query}”`}
      status={notReady.map((provider) => (
        <Fragment key={provider.kind}>
          <ComboboxStatus role="status" aria-label={`${provider.label} isn't ready`}>
            <ProviderGroupLabel provider={provider} />
          </ComboboxStatus>
          {provider.state._tag === "unavailable" && provider.state.reason === "keychain-login" && (
            <div className="px-3 pb-1.5">
              <AgentSignIn provider={provider.kind} />
            </div>
          )}
        </Fragment>
      ))}
      footer={
        <ComboboxFooter>
          <Button variant="ghost-muted" size="micro" disabled={checking} onClick={onCheckAgain}>
            <RefreshCwIcon />
            {checking ? "Checking…" : "Check again"}
          </Button>
        </ComboboxFooter>
      }
      disabled={disabled}
    >
      {value !== null && (
        <ProviderIcon kind={value.provider} className={size === "xs" ? "size-3.5" : "size-4"} />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden="true"
        className={size === "xs" ? "size-3 opacity-50" : "size-3.5 opacity-60"}
      />
    </SearchPicker>
  );
}
