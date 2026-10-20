import { AlertDialog } from "@base-ui/react/alert-dialog";
import { AGENT_KIND_NAMES, type DamagedAgent } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { damagedAgentLabel } from "./damagedAgentLabel";
import { useAgentInstanceActions } from "./useAgentInstanceActions";

/**
 * "Remove claude_work?" or "Reset Claude to default?" for a setting prkit can't read. Either
 * deletes only the setting: prkit can't read which folder or login it named, so those stay.
 */
export function DamagedAgentDialog({
  damaged,
  open,
  onOpenChange,
}: {
  damaged: DamagedAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useAgentInstanceActions();
  const change = damaged.isDefault ? actions.reset : actions.remove;
  const label = damagedAgentLabel(damaged);
  const kind = damaged.kind === null ? null : AGENT_KIND_NAMES[damaged.kind].short;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!change.isPending) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup className="fixed top-[20vh] left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <AlertDialog.Title className="text-sm font-medium">
            {damaged.isDefault ? `Reset ${label} to default?` : `Remove ${label}?`}
          </AlertDialog.Title>
          <AlertDialog.Description
            render={<div />}
            className="mt-2 space-y-2 text-xs text-muted-foreground"
          >
            {damaged.isDefault ? (
              <p>
                Its setting goes back to how prkit ships it. Guides and fixes set to use it then run
                on the login that setup uses, which may not be the one the damaged setting named.
              </p>
            ) : (
              <p>
                Pull requests whose guide or fixes use it move to the default{" "}
                {kind === null ? "agent of their kind" : `${kind} agent`}, or to your default agent
                when that is off.
              </p>
            )}
            <p>
              prkit can't read which folder or login the setting named, so it deletes only the
              setting and those stay as they are.
            </p>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={change.isPending}
              render={<Button size="sm" variant="outline" />}
            >
              Cancel
            </AlertDialog.Close>
            <Button
              size="sm"
              variant="destructive"
              disabled={change.isPending}
              aria-busy={change.isPending}
              onClick={() =>
                change.mutate(
                  { instance: damaged.instance, label },
                  { onSuccess: () => onOpenChange(false) },
                )
              }
            >
              <ButtonLabel
                shown={change.isPending ? "working" : "idle"}
                labels={
                  damaged.isDefault
                    ? { idle: "Reset", working: "Resetting…" }
                    : { idle: "Remove", working: "Removing…" }
                }
              />
            </Button>
          </div>
          {change.error !== null && !change.isPending && (
            <p role="alert" className="mt-3 text-xs text-error-foreground">
              {change.error.message}
            </p>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
