import type { RepositoryFixerSettings } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Switch } from "~/components/ui/switch";
import { updateFixerSettings } from "~/rpc/client";
import { fixerSettingsQuery } from "~/rpc/queries";

/**
 * A repository's opt-ins: push the agent's fixes and resolve new conflicts without a
 * click, and run its check scripts on any pull request.
 */
export function RepositoryFixToggles({
  settings,
  onSaved,
}: {
  settings: RepositoryFixerSettings;
  onSaved?: () => void;
}) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: updateFixerSettings,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: fixerSettingsQuery.queryKey });
      void client.invalidateQueries({ queryKey: ["fixer"] });
      onSaved?.();
    },
  });
  const current =
    update.isPending && update.variables ? { ...settings, ...update.variables } : settings;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          <span className="block text-sm">Push fixes automatically</span>
          <span className="block text-muted-foreground">
            Skips the Push click. Never for a rebase, a revert, or a file that needs you.
          </span>
        </span>
        <Switch
          checked={current.pushAutomatically}
          disabled={update.isPending}
          aria-label={`Push fixes automatically for ${settings.repository}`}
          onCheckedChange={(checked) =>
            update.mutate({ repository: settings.repository, pushAutomatically: checked })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          <span className="block text-sm">Resolve conflicts automatically</span>
          <span className="block text-muted-foreground">
            The agent merges the base when a pull request here starts to conflict, at most three
            times a day per pull request.
          </span>
        </span>
        <Switch
          checked={current.resolveAutomatically}
          disabled={update.isPending}
          aria-label={`Resolve conflicts automatically for ${settings.repository}`}
          onCheckedChange={(checked) =>
            update.mutate({ repository: settings.repository, resolveAutomatically: checked })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          <span className="block text-sm">Run check scripts on any pull request</span>
          <span className="block text-muted-foreground">
            Lets the fix agent run this repository's check scripts on every pull request, forks and
            outside authors included. Their commands come from the pull request. Off, they run only
            on pull requests from this repository by you, a member or a collaborator.
          </span>
        </span>
        <Switch
          checked={current.runScriptsOnAnyPullRequest}
          disabled={update.isPending}
          aria-label={`Run check scripts on any pull request for ${settings.repository}`}
          onCheckedChange={(checked) =>
            update.mutate({ repository: settings.repository, runScriptsOnAnyPullRequest: checked })
          }
        />
      </div>
      {update.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {update.error.message}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => update.variables && update.mutate(update.variables)}
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
