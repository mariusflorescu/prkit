import {
  AccountId,
  type LocalReviewFeedEvent,
  LocalReviewKey,
  PullRequestKey,
  type ReviewFeedEvent,
  refFromKey,
} from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { applyLocalFeedEvent } from "~/features/localReviews/localReviewCache";
import { desktopBridge } from "~/lib/desktop";
import { watchLocalReviewFeed, watchReviewFeed } from "~/rpc/client";
import { type ReviewFeed, reviewFeedQuery } from "~/rpc/queries";

const isKey = Schema.is(PullRequestKey);
const isLocalKey = Schema.is(LocalReviewKey);
const isAccount = Schema.is(AccountId);
const chaptersOf = (count: number) => `${count} chapter${count === 1 ? "" : "s"}`;

/**
 * Follows every review for the whole app: keeps the review index (inbox marks) and the
 * local reviews' list current, and says "Guide ready" with a toast and a macOS notification
 * unless the user is already looking at that guide.
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
    const viewingLocal = (key: LocalReviewKey) =>
      document.hasFocus() &&
      decodeURIComponent(latest.current.location.pathname) === `/local/${key}`;
    const onLocalEvent = (event: LocalReviewFeedEvent) => {
      applyLocalFeedEvent(client, event);
      if (event._tag !== "ready") return;
      void client.invalidateQueries({ queryKey: ["typicalDuration"] });
      if (viewingLocal(event.key)) return;
      const title = event.revision === 1 ? "Guide ready" : "Guide updated";
      const body = `${event.title} · ${chaptersOf(event.chapters)}`;
      toastManager.add({
        title,
        description: body,
        type: "success",
        actionProps: {
          children: "Open",
          onClick: () => latest.current.workspace.openLocal(event.key),
        },
      });
      desktopBridge?.notify({ target: { kind: "local", key: event.key }, title, body });
    };
    const onEvent = (event: ReviewFeedEvent) => {
      switch (event._tag) {
        case "index":
          client.setQueryData(reviewFeedQuery.queryKey, {
            _tag: "live",
            reviews: new Map(event.reviews.map((review) => [review.key, review])),
          });
          return;
        case "changed":
          client.setQueryData(reviewFeedQuery.queryKey, (previous): ReviewFeed | undefined =>
            previous?._tag === "live"
              ? {
                  _tag: "live",
                  reviews: new Map(previous.reviews).set(event.review.key, event.review),
                }
              : previous,
          );
          return;
        case "ready": {
          // A new accepted guide is a new sample for "usually about N min".
          void client.invalidateQueries({ queryKey: ["typicalDuration"] });
          if (viewing(event.key)) return;
          const chapters = chaptersOf(event.chapters);
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
            target: { kind: "pull-request", key: event.key, accountId: event.accountId },
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
          desktopBridge?.notify({
            target: { kind: "pull-request", key: event.key, accountId: event.accountId },
            title,
            body,
          });
        }
      }
    };
    // A failed feed keeps what it read before and says why, so nothing waits on it and a feed
    // prkit couldn't read never looks like one with no reviews.
    const stopFeed = watchReviewFeed(onEvent, (message) =>
      client.setQueryData(reviewFeedQuery.queryKey, (previous): ReviewFeed => ({
        _tag: "failed",
        reviews: previous?.reviews ?? null,
        message,
      })),
    );
    const stopLocalFeed = watchLocalReviewFeed(onLocalEvent);
    const stopClicks = desktopBridge?.onOpenGuide((target) => {
      if (target.kind === "local") {
        if (isLocalKey(target.key)) latest.current.workspace.openLocal(target.key);
        return;
      }
      // Fix notices ask for the Fixes tab; see FixerNotifications.
      // A local review's key is a string too; it never opens through the PR path.
      if (isKey(target.key) && !isLocalKey(target.key) && isAccount(target.accountId))
        openGuide(target.key, target.accountId, target.tab);
    });
    return () => {
      stopFeed();
      stopLocalFeed();
      stopClicks?.();
    };
  }, [client]);
  return null;
}
