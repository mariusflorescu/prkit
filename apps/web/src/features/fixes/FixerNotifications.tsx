import { type FixerFeedEvent, refFromKey } from "@prkit/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { desktopBridge } from "~/lib/desktop";
import { watchFixerFeed } from "~/rpc/client";
import { fixerFeedQuery } from "~/rpc/queries";

/**
 * Follows every PR's fix session for the whole app: keeps the index current for
 * tab marks, and says "Fixes ready" with a toast and a macOS notification unless
 * the user is already looking at that PR's Fixes tab. A notification click is
 * handled with the guide's (GuideNotifications) and opens the Fixes tab.
 */
export function FixerNotifications() {
  const client = useQueryClient();
  // Observed for the app's lifetime, so the index outlives every view that reads it.
  useQuery(fixerFeedQuery);
  const workspace = useWorkspace();
  const location = useRouterState({ select: (state) => state.location });
  const latest = useRef({ location, workspace });
  useEffect(() => {
    latest.current = { location, workspace };
  });

  useEffect(() => {
    const viewing = (key: Parameters<typeof refFromKey>[0]) => {
      const ref = refFromKey(key);
      const { location: current } = latest.current;
      if (ref === null || !document.hasFocus()) return false;
      const onPage = current.pathname === `/pr/${ref.host}/${ref.owner}/${ref.repo}/${ref.number}`;
      const tab = current.search.tab ?? useWorkspaceSession.getState().views[key]?.tab;
      return onPage && tab === "fixes";
    };
    const onEvent = (event: FixerFeedEvent) => {
      switch (event._tag) {
        case "index":
          client.setQueryData(
            fixerFeedQuery.queryKey,
            new Map(event.fixers.map((entry) => [entry.key, entry])),
          );
          return;
        case "changed":
          client.setQueryData(fixerFeedQuery.queryKey, (previous) =>
            new Map(previous).set(event.fixer.key, event.fixer),
          );
          return;
        case "notice": {
          if (viewing(event.key)) return;
          toastManager.add({
            title: event.title,
            description: event.body,
            type: event.title.startsWith("The agent") ? "error" : "success",
            actionProps: {
              children: "Open",
              onClick: () => {
                useWorkspaceSession.getState().rememberTab(event.key, "fixes");
                latest.current.workspace.open(event.key, event.accountId);
              },
            },
          });
          desktopBridge?.notify({
            target: {
              kind: "pull-request",
              key: event.key,
              accountId: event.accountId,
              tab: "fixes",
            },
            title: event.title,
            body: event.body,
          });
        }
      }
    };
    return watchFixerFeed(onEvent);
  }, [client]);
  return null;
}
