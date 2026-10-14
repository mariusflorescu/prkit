import { Button } from "~/components/ui/button";

import { useWorkspaceSession } from "./sessionStore";
import { useWorkspace } from "./workspaceContext";

export function WorkspaceMutationError() {
  const failed = useWorkspaceSession((state) => state.failed);
  const workspace = useWorkspace();
  if (!failed) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-error/30 bg-error-surface p-3 text-xs text-error-foreground"
    >
      <p>{failed.message}</p>
      <Button size="sm" variant="outline" onClick={() => workspace.send(failed.command)}>
        Retry
      </Button>
    </div>
  );
}
