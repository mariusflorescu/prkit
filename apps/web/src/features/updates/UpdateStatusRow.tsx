import type { DesktopUpdateState } from "@prkit/contracts";
import { ArrowDownToLineIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ago } from "~/features/github/freshness";
import { useNow } from "~/features/github/useNow";
import { SettingsAlert } from "~/features/settings/SettingsAlert";

import { InstallUpdateDialog } from "./InstallUpdateDialog";
import { ReleaseNotesList } from "./ReleaseNotesList";
import { updateErrorMessage, useUpdateAction } from "./updateQueries";

const STATUS_TEXT: Record<DesktopUpdateState["status"], (state: DesktopUpdateState) => string> = {
  disabled: (state) => state.disabledReason ?? "Updates are off.",
  idle: () => "prkit checks for updates shortly after it starts.",
  checking: () => "Checking for updates…",
  "up-to-date": () => "You're up to date.",
  available: (state) => `${state.availableVersion} is available.`,
  downloading: (state) =>
    `Downloading ${state.availableVersion}: ${Math.round(state.downloadPercent ?? 0)}%`,
  downloaded: (state) => `${state.availableVersion} is downloaded. Restart prkit to install it.`,
  error: () => "The last check didn't finish.",
};

/** Where updates stand, the button that moves them on, and the incoming notes. */
export function UpdateStatusRow({ state }: { state: DesktopUpdateState }) {
  const now = useNow();
  const check = useUpdateAction("check");
  const download = useUpdateAction("download");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = state.status === "checking" || state.status === "downloading";
  const failure = check.error ?? download.error;
  const offered =
    state.status === "available" || state.status === "downloading" || state.status === "downloaded";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p role="status" data-update-status={state.status} className="text-sm text-foreground">
            {STATUS_TEXT[state.status](state)}
          </p>
          {state.lastCheckedAt !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Last checked {ago(state.lastCheckedAt, now)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {state.status === "available" && (
            <Button size="sm" disabled={download.isPending} onClick={() => download.mutate()}>
              <ArrowDownToLineIcon aria-hidden />
              Download
            </Button>
          )}
          {state.status === "downloaded" && (
            <Button size="sm" onClick={() => setConfirmOpen(true)}>
              <RotateCwIcon aria-hidden />
              Restart to update
            </Button>
          )}
          {state.status !== "disabled" && state.status !== "error" && !offered && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || check.isPending}
              aria-busy={state.status === "checking"}
              onClick={() => check.mutate()}
            >
              {state.status === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
      </div>
      {state.status === "error" && state.errorMessage !== null && (
        <SettingsAlert message={state.errorMessage} retry={() => check.mutate()} />
      )}
      {state.errorContext === "download" && state.errorMessage !== null && (
        <SettingsAlert message={state.errorMessage} retry={() => download.mutate()} />
      )}
      {state.errorContext === "install" && state.errorMessage !== null && (
        <SettingsAlert message={state.errorMessage} retry={() => setConfirmOpen(true)} />
      )}
      {failure !== null && (
        <SettingsAlert
          message={updateErrorMessage(failure)}
          retry={() => (check.error !== null ? check.mutate() : download.mutate())}
        />
      )}
      {offered && (
        <div className="rounded-lg border border-border/70 bg-card/60 p-4">
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">What's new</h3>
          <ReleaseNotesList notes={state.releaseNotes} releasesUrl={null} />
        </div>
      )}
      {state.status === "downloaded" && (
        <InstallUpdateDialog state={state} open={confirmOpen} onOpenChange={setConfirmOpen} />
      )}
    </div>
  );
}
