import { TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useWorkspace } from "~/features/workspace/workspaceContext";

/**
 * After the tabs, where stored tabs prkit couldn't read would be: that they are there, never
 * which pull request they held, and Remove, which deletes them for good.
 */
export function DamagedTabsNotice({ keys }: { keys: ReadonlyArray<string> }) {
  const workspace = useWorkspace();
  return (
    <div
      role="status"
      aria-label="Open tabs prkit couldn't restore"
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-warning/30 bg-warning-surface pr-0.5 pl-2 text-xs whitespace-nowrap text-warning-foreground [-webkit-app-region:no-drag]"
    >
      <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      {keys.length === 1 ? "One open tab" : `${keys.length} open tabs`} couldn't be restored
      <Button
        size="micro"
        variant="ghost-muted"
        onClick={() => workspace.send({ kind: "remove-damaged", keys })}
      >
        Remove
      </Button>
    </div>
  );
}
