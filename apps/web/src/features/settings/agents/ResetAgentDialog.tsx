import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { AgentCatalogEntry } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { useAgentInstanceActions } from "./useAgentInstanceActions";

/**
 * "Reset Claude to default?" Resetting drops everything the user set on a default instance,
 * its environment and sensitive values included, so it asks first.
 */
export function ResetAgentDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: AgentCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { reset } = useAgentInstanceActions();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!reset.isPending) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup className="fixed top-[20vh] left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <AlertDialog.Title className="text-sm font-medium">
            Reset {entry.label} to default?
          </AlertDialog.Title>
          <AlertDialog.Description
            render={<div />}
            className="mt-2 space-y-2 text-xs text-muted-foreground"
          >
            <p>
              Its name, accent, binary, config folder and environment variables go back to how prkit
              ships them. Sensitive values saved for it are deleted.
            </p>
            <p>
              {entry.configDir === null
                ? "Its login stays, and the guides and fixes that use it carry on."
                : `It stops using ${entry.configDir}: it runs on the login of the default folder, and the guides and fixes that use it start new conversations.`}
            </p>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={reset.isPending}
              render={<Button size="sm" variant="outline" />}
            >
              Cancel
            </AlertDialog.Close>
            <Button
              size="sm"
              variant="destructive"
              disabled={reset.isPending}
              aria-busy={reset.isPending}
              onClick={() => reset.mutate(entry, { onSuccess: () => onOpenChange(false) })}
            >
              <ButtonLabel
                shown={reset.isPending ? "resetting" : "reset"}
                labels={{ reset: "Reset", resetting: "Resetting…" }}
              />
            </Button>
          </div>
          {reset.error !== null && !reset.isPending && (
            <p role="alert" className="mt-3 text-xs text-error-foreground">
              {reset.error.message}
            </p>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
