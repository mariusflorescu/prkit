import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { LocalReview } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useWorkspace } from "~/features/workspace/workspaceContext";

import { localTitle } from "./localPresentation";
import { useLocalReviewActions } from "./useLocalReviewActions";

/**
 * "Remove the local review of widgets · feature/limits?" Its revisions and prkit's copy of its
 * snapshots go; the user's repository is never touched. A failure keeps the dialog open.
 */
export function RemoveLocalReviewDialog({
  review,
  open,
  onOpenChange,
}: {
  review: LocalReview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspace = useWorkspace();
  const { remove } = useLocalReviewActions(review.key);
  const title = localTitle(review.source);
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
            Remove the local review of {title}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            Its guides and prkit's copy of its snapshots are deleted. Your repository isn't touched,
            and running prkit local guide there starts a new one.
          </AlertDialog.Description>
          {remove.error !== null && !remove.isPending && (
            <p role="alert" className="mt-3 text-xs text-error-foreground">
              {remove.error.message}
            </p>
          )}
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
              // The removal empties the page under the dialog, so this runs off the promise,
              // which settles whether or not the dialog is still mounted. A failure shows above.
              onClick={() =>
                void remove.mutateAsync().then(
                  () => {
                    onOpenChange(false);
                    workspace.closeLocal(review.key);
                    toastManager.add({ title: "Local review removed", description: title });
                  },
                  () => undefined,
                )
              }
            >
              {remove.isPending ? "Removing…" : remove.error !== null ? "Try again" : "Remove"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
