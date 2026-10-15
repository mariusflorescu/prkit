import type { OpenPullRequest } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";

import { desktopBridge } from "~/lib/desktop";
import { watchWorkspace } from "~/rpc/client";
import { workspaceQuery } from "~/rpc/queries";

/**
 * Applies open-PR changes made elsewhere (an outside agent) as they arrive. One asked to
 * focus shows that PR and brings the window forward; without a window, the PR is open and
 * active when one opens.
 */
export function useWorkspaceChanges(show: (row: OpenPullRequest) => void) {
  const client = useQueryClient();
  const reveal = useEffectEvent(show);
  useEffect(
    () =>
      watchWorkspace((change) => {
        // A change of this window's own still in flight lands after; refetch to settle both.
        if (client.isMutating({ mutationKey: ["workspace-change"] }) > 0)
          void client.invalidateQueries({ queryKey: workspaceQuery.queryKey });
        else client.setQueryData(workspaceQuery.queryKey, change.workspace);
        const focus = change.focus;
        if (focus === null) return;
        const row = change.workspace.open.find((open) => open.key === focus.key);
        if (row === undefined) return;
        reveal(row);
        desktopBridge?.bringForward();
      }),
    [client],
  );
}
