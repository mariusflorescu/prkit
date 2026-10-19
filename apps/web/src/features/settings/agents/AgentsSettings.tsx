import { useQuery } from "@tanstack/react-query";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { toastManager } from "~/components/ui/toast";
import { useGuideSettings } from "~/features/guides/useGuideSettings";
import { agentCatalogQuery } from "~/rpc/queries";

import { FailedSave } from "../FailedSave";
import { SettingsAlert } from "../SettingsAlert";
import { SettingsSection } from "../SettingsSection";
import { AddAgentDialog } from "./AddAgentDialog";
import { AgentInstanceCard } from "./AgentInstanceCard";
import { DefaultAgentSetting } from "./DefaultAgentSetting";
import { useCheckAgents } from "./useCheckAgents";

/**
 * Settings > Agents: every agent setup on this machine (each kind's default, then the ones the
 * user added), its sign-in, and which one writes guides by default.
 */
export function AgentsSettings() {
  const catalog = useQuery(agentCatalogQuery);
  const { settings, update } = useGuideSettings();
  const checkAgain = useCheckAgents();
  const [adding, setAdding] = useState(false);
  const loadError = catalog.error ?? settings.error;
  const data =
    catalog.data !== undefined && settings.data !== undefined
      ? { catalog: catalog.data, settings: settings.data }
      : undefined;
  return (
    <SettingsSection
      title="Agents"
      description="Guides and fixes are written by Claude Code, Codex or Cursor, signed in with your own plan on this machine. Add another setup of one to use a second account."
      action={
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={checkAgain.isPending}
            onClick={() => checkAgain.mutate()}
          >
            <ButtonLabel
              icon={<RefreshCwIcon className="size-3.5" />}
              shown={checkAgain.isPending ? "checking" : "check"}
              labels={{ check: "Check again", checking: "Checking…" }}
            />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={data === undefined}
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3.5" />
            Add agent
          </Button>
        </div>
      }
    >
      {checkAgain.error !== null && (
        <SettingsAlert message={checkAgain.error.message} retry={() => checkAgain.mutate()} />
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
          {data.catalog.providers.length === 0 ? (
            <p
              role="status"
              className="border-b border-border/60 py-6 text-center text-xs text-muted-foreground"
            >
              prkit found no agents. Check again, or add one.
            </p>
          ) : (
            <ul aria-label="Agents">
              {data.catalog.providers.map((entry) => (
                <AgentInstanceCard
                  key={entry.instance}
                  entry={entry}
                  catalog={data.catalog}
                  checkingAll={checkAgain.isPending}
                />
              ))}
            </ul>
          )}
          <DefaultAgentSetting
            catalog={data.catalog}
            settings={data.settings}
            onChange={(defaultAgent) =>
              update.mutate(
                { defaultAgent },
                {
                  onSuccess: () =>
                    toastManager.add({ title: "Saved the default agent", type: "success" }),
                },
              )
            }
            saving={update.isPending}
          />
          <FailedSave save={update} />
          <AddAgentDialog catalog={data.catalog} open={adding} onOpenChange={setAdding} />
        </div>
      )}
    </SettingsSection>
  );
}
