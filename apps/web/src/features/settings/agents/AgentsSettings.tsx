import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";
import { useGuideSettings } from "~/features/guides/useGuideSettings";
import { agentCatalogQuery } from "~/rpc/queries";

import { SettingsAlert } from "../SettingsAlert";
import { SettingsSection } from "../SettingsSection";
import { DefaultAgentSetting } from "./DefaultAgentSetting";
import { ProviderStatusRow } from "./ProviderStatusRow";
import { useCheckAgents } from "./useCheckAgents";

/** Settings > Agents: which agents can write guides on this machine, and which one is the default. */
export function AgentsSettings() {
  const catalog = useQuery(agentCatalogQuery);
  const { settings, update } = useGuideSettings();
  const checkAgain = useCheckAgents();
  const loadError = catalog.error ?? settings.error;
  const data =
    catalog.data !== undefined && settings.data !== undefined
      ? { catalog: catalog.data, settings: settings.data }
      : undefined;
  return (
    <SettingsSection
      title="Agents"
      description="Guides are written by Claude Code or Codex, signed in with your own subscription on this machine."
      action={
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={checkAgain.isPending}
          onClick={() => checkAgain.mutate()}
        >
          <RefreshCwIcon className="size-3.5" />
          {checkAgain.isPending ? "Checking..." : "Check again"}
        </Button>
      }
    >
      {checkAgain.error !== null && (
        <SettingsAlert message={checkAgain.error.message} retry={() => checkAgain.mutate()} />
      )}
      {update.error !== null && (
        <SettingsAlert
          message={update.error.message}
          retry={() => {
            const last = update.variables;
            update.reset();
            if (last !== undefined) update.mutate(last);
          }}
        />
      )}
      {loadError !== null ? (
        <ListError
          title="Couldn't load agents"
          message={loadError.message}
          retry={() => {
            void catalog.refetch();
            void settings.refetch();
          }}
        />
      ) : data === undefined ? (
        <ListSkeleton label="Loading agents" rows={3} kind="accounts" />
      ) : (
        <div className="mt-5 border-t border-border/60">
          <ul aria-label="Agent sign-in status">
            {data.catalog.providers.map((provider) => (
              <ProviderStatusRow key={provider.kind} provider={provider} />
            ))}
          </ul>
          <DefaultAgentSetting
            catalog={data.catalog}
            settings={data.settings}
            onChange={(defaultAgent) => update.mutate({ defaultAgent })}
            saving={update.isPending}
          />
        </div>
      )}
    </SettingsSection>
  );
}
