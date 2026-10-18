import type {
  OpenPullRequest,
  PullRequestKey,
  WorkspaceChange,
  WorkspaceCommand,
} from "@prkit/contracts";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { desktopBridge } from "~/lib/desktop";
import { watchWorkspace } from "~/rpc/client";
import { workspaceQuery } from "~/rpc/queries";

import { currentWorkspace, shownPullRequest, workspaceMutationKey } from "./workspaceView";

/**
 * Keeps the open tabs in step with changes made elsewhere (an outside agent). Each time the
 * subscription goes live, a reconnect included, the server sends the tabs as they are, so what
 * changed while the window was away shows up. A window never takes a copy older than the one it
 * has. A change asked to focus shows that PR and brings the window forward; without a window,
 * the PR is open and active when one opens.
 */
export function useWorkspaceChanges({
  show,
  send,
}: {
  show: (row: OpenPullRequest | null) => void;
  send: (command: WorkspaceCommand) => void;
}) {
  const client = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const confirmed = useQuery(workspaceQuery).data;
  const mutations = useIsMutating({ mutationKey: workspaceMutationKey });
  /** A focus on a tab this window is closing: whichever came last decides, once the close lands. */
  const waitingFocus = useRef<PullRequestKey | null>(null);
  const reveal = useEffectEvent((row: OpenPullRequest) => {
    show(row);
    desktopBridge?.bringForward();
  });
  useEffect(() => {
    const key = waitingFocus.current;
    if (key === null || mutations > 0 || confirmed === undefined) return;
    waitingFocus.current = null;
    const row = confirmed.open.find((open) => open.key === key);
    if (row !== undefined) reveal(row);
  }, [mutations, confirmed]);
  const apply = useEffectEvent((change: WorkspaceChange) => {
    // The query keeps whichever copy is newer.
    client.setQueryData(workspaceQuery.queryKey, change.workspace);
    const shown = currentWorkspace(client);
    if (change._tag === "changed" && change.focus !== null) {
      const focus = change.focus;
      waitingFocus.current = null;
      const row = shown?.open.find((open) => open.key === focus.key);
      if (row !== undefined) return reveal(row);
      if (client.getQueryData(workspaceQuery.queryKey)?.open.some((open) => open.key === focus.key))
        waitingFocus.current = focus.key;
      return;
    }
    // Back from being away, as after a reload: the PR on screen is the active one.
    const onScreen = shownPullRequest(shown, pathname);
    if (change._tag === "current" && onScreen !== undefined && shown?.activeKey !== onScreen.key)
      send({ kind: "activate", key: onScreen.key });
  });
  useEffect(() => watchWorkspace((change) => apply(change)), []);
}
