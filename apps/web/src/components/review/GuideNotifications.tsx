import { AccountId, PullRequestKey, type ReviewFeedEvent, refFromKey } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { desktopBridge } from "~/lib/desktop";
import { watchReviewFeed } from "~/rpc/client";
import { reviewFeedQuery } from "~/rpc/queries";

const isKey = Schema.is(PullRequestKey);
const isAccount = Schema.is(AccountId);

/**
 * Follows every review for the whole app: keeps the review index (inbox marks)
 * current, and says "Guide ready" with a toast and a macOS notification unless
 * the user is already looking at that guide.
 */
export function GuideNotifications() {
  const client = useQueryClient();
  const workspace = useWorkspace();
  const location = useRouterState({ select: (state) => state.location });
  const latest = useRef({ location, workspace });
  useEffect(() => {
    latest.current = { location, workspace };
  });

  useEffect(() => {
    const openGuide = (
      key: PullRequestKey,
      accountId: AccountId,
      tab: "guide" | "fixes" = "guide",
    ) => {
      useWorkspaceSession.getState().rememberTab(key, tab);
      latest.current.workspace.open(key, accountId);
    };
    const viewing = (key: PullRequestKey) => {
      const ref = refFromKey(key);
      const { location: current } = latest.current;
      if (ref === null || !document.hasFocus()) return false;
      const onPage = current.pathname === `/pr/${ref.host}/${ref.owner}/${ref.repo}/${ref.number}`;
      const tab = current.search.tab ?? useWorkspaceSession.getState().views[key]?.tab;
      return onPage && tab === "guide";
    };
    const onEvent = (event: ReviewFeedEvent) => {
      switch (event._tag) {
        case "index":
          client.setQueryData(
            reviewFeedQuery.queryKey,
            new Map(event.reviews.map((review) => [review.key, review])),
          );
          return;
        case "changed":
          client.setQueryData(reviewFeedQuery.queryKey, (previous) =>
            new Map(previous).set(event.review.key, event.review),
          );
          return;
        case "ready": {
          // A new accepted guide is a new sample for "usually about N min".
          void client.invalidateQueries({ queryKey: ["typicalDuration"] });
          if (viewing(event.key)) return;
          const chapters = `${event.chapters} chapter${event.chapters === 1 ? "" : "s"}`;
          toastManager.add({
            title: event.revision === 1 ? "Guide ready" : "Guide updated",
            description: `${event.title} · ${chapters}`,
            type: "success",
            actionProps: {
              children: "Open",
              onClick: () => openGuide(event.key, event.accountId),
            },
          });
          desktopBridge?.notify({
            key: event.key,
            accountId: event.accountId,
            title: event.revision === 1 ? "Guide ready" : "Guide updated",
            body: `${event.title} · ${chapters}`,
          });
          return;
        }
        case "stack-ready": {
          void client.invalidateQueries({ queryKey: ["typicalDuration"] });
          const total = event.ready + event.failed;
          const title =
            event.failed === 0
              ? "Stack guides ready"
              : event.ready === 0
                ? "Stack guides failed"
                : "Stack guides finished";
          const body =
            event.failed === 0
              ? `${total} PR${total === 1 ? "" : "s"}`
              : `${event.ready} ready · ${event.failed} failed`;
          toastManager.add({
            title,
            description: body,
            type: event.failed === 0 ? "success" : "error",
            actionProps: {
              children: "Open",
              onClick: () => openGuide(event.key, event.accountId),
            },
          });
          desktopBridge?.notify({ key: event.key, accountId: event.accountId, title, body });
        }
      }
    };
    const stopFeed = watchReviewFeed(onEvent);
    const stopClicks = desktopBridge?.onOpenGuide((target) => {
      // Fix notices ask for the Fixes tab; see FixerNotifications.
      if (isKey(target.key) && isAccount(target.accountId))
        openGuide(target.key, target.accountId, target.tab);
    });
    return () => {
      stopFeed();
      stopClicks?.();
    };
  }, [client]);
  return null;
}
