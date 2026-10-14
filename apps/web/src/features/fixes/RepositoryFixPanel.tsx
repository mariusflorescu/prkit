import type { GuideRepository } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { ListError } from "~/components/ListError";
import { Skeleton } from "~/components/ui/skeleton";
import { fixerSettingsQuery } from "~/rpc/queries";

import { RepositoryFixToggles } from "./RepositoryFixToggles";

/** Settings > Guides > For one repository: the fix agent's opt-ins, next to the guide settings. */
export function RepositoryFixPanel({ repository }: { repository: GuideRepository }) {
  const settings = useQuery(fixerSettingsQuery);
  const id = `${repository.host}/${repository.owner}/${repository.name}`;
  return (
    <section
      aria-label={`Fix agent for ${repository.owner}/${repository.name}`}
      className="space-y-3 border-t border-border/60 pt-4"
    >
      <div>
        <h4 className="text-sm font-medium">Fix agent</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          All are off until you turn them on. prkit commits for the agent and always waits for a
          click before a rebase's force-push or when a file needs you.
        </p>
      </div>
      {settings.isError ? (
        <ListError
          title="Couldn't load the fix agent settings"
          message={settings.error.message}
          retry={() => void settings.refetch()}
        />
      ) : settings.isPending ? (
        <div aria-busy="true" aria-label="Loading fix agent settings" className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <RepositoryFixToggles
          settings={
            settings.data.find((row) => row.repository === id) ?? {
              repository: id,
              pushAutomatically: false,
              resolveAutomatically: false,
              runScriptsOnAnyPullRequest: false,
            }
          }
        />
      )}
    </section>
  );
}
