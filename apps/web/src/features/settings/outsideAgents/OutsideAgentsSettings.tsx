import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";

import { FailedSave } from "../FailedSave";
import { SettingsAlert } from "../SettingsAlert";
import { SettingsSection } from "../SettingsSection";
import { CommandLineSettings } from "./CommandLineSettings";
import { OutsideAgentsForm } from "./OutsideAgentsForm";
import { OutsideClientsList } from "./OutsideClientsList";
import { OutsideSetupCommands } from "./OutsideSetupCommands";
import { useOutsideAgents } from "./useOutsideAgents";

/** Settings > Outside agents: let the owner's own MCP client read prkit and start work in it. */
export function OutsideAgentsSettings() {
  const { state, update, reset } = useOutsideAgents();
  return (
    <SettingsSection
      title="Outside agents"
      description="Let Claude Code, Codex or another MCP client on this machine see your inbox and start work in prkit. Pushing, merging and posting to GitHub always stay a click here."
      action={
        state.data?.enabled === true && (
          <Button
            size="sm"
            variant="outline"
            disabled={reset.isPending}
            aria-busy={reset.isPending}
            onClick={() => reset.mutate()}
          >
            {reset.isPending ? "Resetting…" : "Reset access"}
          </Button>
        )
      }
    >
      {reset.error !== null && (
        <SettingsAlert
          message={reset.error.message}
          retry={() => {
            reset.reset();
            reset.mutate();
          }}
        />
      )}
      {state.isPending ? (
        <ListSkeleton label="Loading outside agents" rows={2} kind="accounts" />
      ) : state.isError ? (
        <ListError
          title="Couldn't load outside agents"
          message={state.error.message}
          retry={() => void state.refetch()}
        />
      ) : (
        <>
          <OutsideAgentsForm
            settings={{ enabled: state.data.enabled, access: state.data.access }}
            saving={update.isPending}
            onSave={(settings) => update.mutateAsync(settings)}
          />
          <FailedSave save={update} />
          <CommandLineSettings enabled={state.data.enabled} access={state.data.access} />
          {state.data.launcherProblem !== null && (
            <SettingsAlert
              message={state.data.launcherProblem}
              retry={() => void state.refetch()}
            />
          )}
          {state.data.enabled && (
            <>
              {state.data.launcherProblem === null && (
                <OutsideSetupCommands launcher={state.data.launcher} />
              )}
              <OutsideClientsList clients={state.data.clients} />
              {state.data.launcherProblem === null && (
                <p className="border-t border-border/60 py-3 text-xs text-muted-foreground">
                  Reset access makes a new key; anything using a copied key stops working. Clients
                  added with the command above pick up the new key by themselves.
                </p>
              )}
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}
