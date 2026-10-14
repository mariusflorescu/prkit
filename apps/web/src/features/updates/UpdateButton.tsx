import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLineIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";

import { InstallUpdateDialog } from "./InstallUpdateDialog";
import { ReleaseNotesList } from "./ReleaseNotesList";
import { desktopUpdateQuery, updateErrorMessage, useUpdateAction } from "./updateQueries";

/**
 * The title bar's update button, there only while an update is on offer. Available, a click
 * downloads it; downloading, it shows progress; downloaded, a click asks to restart. Hovering or
 * focusing it shows what's new in the incoming version.
 */
export function UpdateButton() {
  const update = useQuery(desktopUpdateQuery);
  const download = useUpdateAction("download");
  const [notesOpen, setNotesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const state = update.data;
  if (
    state === undefined ||
    (state.status !== "available" &&
      state.status !== "downloading" &&
      state.status !== "downloaded")
  )
    return null;

  const percent = Math.round(state.downloadPercent ?? 0);
  const failure =
    download.error !== null
      ? updateErrorMessage(download.error)
      : state.errorContext === "download"
        ? state.errorMessage
        : null;
  const act = () => {
    if (state.status === "available") download.mutate();
    if (state.status === "downloaded") {
      setNotesOpen(false);
      setConfirmOpen(true);
    }
  };
  const label =
    state.status === "available"
      ? `Update to ${state.availableVersion}`
      : state.status === "downloading"
        ? `Downloading ${state.availableVersion}, ${percent}%`
        : `Restart to update to ${state.availableVersion}`;

  return (
    <span className="flex shrink-0 [-webkit-app-region:no-drag]">
      <Popover.Root
        open={notesOpen}
        onOpenChange={(open, details) => {
          // A click is the button's action; hover and focus show the notes.
          if (details.reason === "trigger-press") {
            act();
            return;
          }
          setNotesOpen(open);
        }}
      >
        <Popover.Trigger
          openOnHover
          delay={150}
          closeDelay={120}
          aria-label={label}
          data-update-status={state.status}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) setNotesOpen(true);
          }}
          render={
            <Button size="xs" variant={state.status === "downloading" ? "outline" : "default"} />
          }
        >
          {state.status === "available" && (
            <>
              <ArrowDownToLineIcon aria-hidden />
              Update
            </>
          )}
          {state.status === "downloading" && (
            <>
              <span aria-hidden className="relative h-1 w-10 overflow-hidden rounded-full bg-muted">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="tabular-nums">{percent}%</span>
            </>
          )}
          {state.status === "downloaded" && (
            <>
              <RotateCwIcon aria-hidden />
              Restart to update
            </>
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Popover.Popup
              initialFocus={false}
              finalFocus={false}
              className="flex max-h-[min(28rem,var(--available-height))] w-96 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"
            >
              <div className="shrink-0 border-b border-border px-4 pt-3 pb-2">
                <Popover.Title className="text-sm font-medium">What's new</Popover.Title>
                <Popover.Description className="mt-0.5 text-xs text-muted-foreground">
                  {state.status === "downloaded"
                    ? `${state.availableVersion} is downloaded. Restart prkit to install it.`
                    : state.status === "downloading"
                      ? `Downloading ${state.availableVersion}: ${percent}%`
                      : `${state.availableVersion} is ready to download.`}
                </Popover.Description>
                {failure !== null && (
                  <p role="alert" className="mt-1 text-xs text-error-foreground">
                    {failure} Click Update to try again.
                  </p>
                )}
              </div>
              <div className="min-h-0 overflow-y-auto px-4 py-3">
                <ReleaseNotesList notes={state.releaseNotes} releasesUrl={state.releasesUrl} />
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <InstallUpdateDialog state={state} open={confirmOpen} onOpenChange={setConfirmOpen} />
    </span>
  );
}
