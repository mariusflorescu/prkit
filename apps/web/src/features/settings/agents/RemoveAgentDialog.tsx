import { AlertDialog } from "@base-ui/react/alert-dialog";
import { AGENT_KIND_NAMES, type AgentCatalogEntry, type AgentProviderKind } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { configOf } from "./instanceConfig";
import { useAgentInstanceActions } from "./useAgentInstanceActions";

/** What removing leaves of an instance's folders and login. */
const LEFT_BEHIND: Record<AgentProviderKind, (entry: AgentCatalogEntry) => string> = {
  claude: () => "Its config folder and Claude Code login stay as they are.",
  codex: (entry) => {
    const held = entry.login === "prkit" || entry.state.ownLogin;
    const yours =
      entry.login === "prkit"
        ? ""
        : entry.configDir === null
          ? " Your Codex home (~/.codex) and its login stay as they are."
          : " The Codex home you named and its login stay as they are.";
    return held
      ? `prkit signs out the ChatGPT login it holds for it, then deletes its folder. If Codex can't confirm the sign-out, nothing is removed.${yours}`
      : `prkit deletes its own folder for it, after signing out any login it holds there.${yours}`;
  },
  cursor: () =>
    "prkit deletes its folder for it, with the Cursor key its sign-in saved there. The key itself stays valid until it expires: delete it in your Cursor dashboard to end it sooner.",
};

/**
 * "Remove Work?" Removing signs out any login prkit holds for the instance and deletes prkit's
 * folder for it; the user's own config folder stays. Pull requests that used it move on.
 */
export function RemoveAgentDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: AgentCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { remove } = useAgentInstanceActions();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup className="fixed top-[20vh] left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <AlertDialog.Title className="text-sm font-medium">
            Remove {entry.label}?
          </AlertDialog.Title>
          <AlertDialog.Description
            render={<div />}
            className="mt-2 space-y-2 text-xs text-muted-foreground"
          >
            <p>
              Pull requests whose guide or fixes use it move to the default{" "}
              {AGENT_KIND_NAMES[entry.kind].name} agent, or to your default agent when that is off,
              and start a new conversation there.
            </p>
            <p>{LEFT_BEHIND[entry.kind](entry)}</p>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={remove.isPending}
              render={<Button size="sm" variant="outline" />}
            >
              Cancel
            </AlertDialog.Close>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              aria-busy={remove.isPending}
              onClick={() =>
                remove.mutate(configOf(entry), { onSuccess: () => onOpenChange(false) })
              }
            >
              <ButtonLabel
                shown={remove.isPending ? "removing" : "remove"}
                labels={{ remove: "Remove", removing: "Removing…" }}
              />
            </Button>
          </div>
          {remove.error !== null && !remove.isPending && (
            <p role="alert" className="mt-3 text-xs text-error-foreground">
              {remove.error.message}
            </p>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
