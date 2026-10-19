import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { DesktopUpdateState } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { updateErrorMessage, useUpdateAction } from "./updateQueries";

/**
 * "Install <v> and restart prkit?" Restarting stops the server, so running guides and fixes
 * stop with it. On success the app quits and this never closes; a failed install says why.
 */
export function InstallUpdateDialog({
  state,
  open,
  onOpenChange,
}: {
  state: DesktopUpdateState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const install = useUpdateAction("install");
  const failure =
    install.error !== null
      ? updateErrorMessage(install.error)
      : state.errorContext === "install"
        ? state.errorMessage
        : null;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!install.isPending) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup className="fixed top-[20vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <AlertDialog.Title className="text-sm font-medium">
            Install {state.availableVersion} and restart prkit?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            Running guides and fixes will be interrupted.
          </AlertDialog.Description>
          {failure !== null && !install.isPending && (
            <p role="alert" className="mt-3 text-xs text-error-foreground">
              {failure}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={install.isPending}
              render={<Button size="sm" variant="outline" />}
            >
              Cancel
            </AlertDialog.Close>
            <Button
              size="sm"
              disabled={install.isPending}
              aria-busy={install.isPending}
              onClick={() => install.mutate()}
            >
              <ButtonLabel
                shown={install.isPending ? "restarting" : failure !== null ? "retry" : "install"}
                labels={{
                  install: "Install and restart",
                  restarting: "Restarting…",
                  retry: "Try again",
                }}
              />
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
