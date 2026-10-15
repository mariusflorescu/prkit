import type { OpenPullRequest } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { desktopBridge } from "~/lib/desktop";
import { watchWorkspace } from "~/rpc/client";
import { workspaceQuery } from "~/rpc/queries";

/**
 * Applies open-PR changes made elsewhere (an outside agent) as they arrive. One asked to
 * focus shows that PR and brings the window forward; without a window, the PR is open and
 * active when one opens.
 */
export function useWorkspaceChanges(show: (row: OpenPullRequest | null) => void) {
  const client = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const reveal = useEffectEvent(show);
  useEffect(
    () =>
      watchWorkspace((change) => {
        const previous = client.getQueryData(workspaceQuery.queryKey);
        // A change of this window's own still in flight lands after; refetch to settle both.
        if (client.isMutating({ mutationKey: ["workspace-change"] }) > 0)
          void client.invalidateQueries({ queryKey: workspaceQuery.queryKey });
        else client.setQueryData(workspaceQuery.queryKey, change.workspace);
        const focus = change.focus;
        if (focus === null) {
          if (
            pathname.startsWith("/pr/") &&
            previous?.activeKey &&
            !change.workspace.open.some((row) => row.key === previous.activeKey)
          )
            reveal(
              change.workspace.open.find((row) => row.key === change.workspace.activeKey) ?? null,
            );
          return;
        }
        const row = change.workspace.open.find((open) => open.key === focus.key);
        if (row === undefined) return;
        reveal(row);
        desktopBridge?.bringForward();
      }),
    [client, pathname],
  );
}
