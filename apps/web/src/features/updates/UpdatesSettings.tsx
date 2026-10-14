import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";

import { ListError } from "~/components/ListError";
import { Separator } from "~/components/ui/separator";
import { SettingsSection } from "~/features/settings/SettingsSection";

import { UpdatesSettingsSkeleton } from "./UpdatesSettingsSkeleton";
import { UpdateStatusRow } from "./UpdateStatusRow";
import { UpdateTrackSelect } from "./UpdateTrackSelect";
import { desktopUpdateQuery, updateErrorMessage } from "./updateQueries";

/** Settings > Updates, in the desktop app only: the version, the track, and where updates stand. */
export function UpdatesSettings() {
  const update = useQuery(desktopUpdateQuery);
  return (
    <SettingsSection
      title="Updates"
      description="prkit looks for a new version every 30 minutes and asks before it installs one."
    >
      {update.isPending ? (
        <UpdatesSettingsSkeleton />
      ) : update.isError ? (
        <ListError
          title="Couldn't read the update status"
          message={updateErrorMessage(update.error)}
          retry={() => void update.refetch()}
        />
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-sm text-foreground">
            Version{" "}
            <span className="font-mono text-xs tabular-nums">{update.data.currentVersion}</span>
          </p>
          <UpdateTrackSelect state={update.data} />
          <Separator />
          <UpdateStatusRow state={update.data} />
          {update.data.releasesUrl !== null && (
            <a
              href={update.data.releasesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              All releases on GitHub
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
