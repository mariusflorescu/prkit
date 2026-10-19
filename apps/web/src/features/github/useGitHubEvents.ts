import type { GitHubEvent } from "@prkit/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchGitHub } from "~/rpc/client";
import {
  inboxQuery,
  pullRequestQueryKeys,
  pullRequestStatusQuery,
  repositoriesQuery,
} from "~/rpc/queries";

const statusKey = (accountId: string, key: string) => `${accountId}:${key}`;

const PULL_REQUEST_READS = [
  "pullRequest",
  "pullRequestTimeline",
  "reviewThreads",
  "pullRequestFiles",
  "pullRequestStack",
];

const applyTo = (client: QueryClient) => (event: GitHubEvent, reopened: boolean) => {
  switch (event._tag) {
    case "opened":
      client.setQueryData(
        pullRequestStatusQuery.queryKey,
        new Map(event.statuses.map((status) => [statusKey(status.accountId, status.key), status])),
      );
      // The inbox's first answer may have started reads that landed before this opened.
      void client.invalidateQueries({ queryKey: inboxQuery.queryKey });
      if (!reopened) return;
      // Changes made while this window was hidden or offline were never sent; the
      // server answers these from its cache unless GitHub really changed.
      for (const name of PULL_REQUEST_READS) void client.invalidateQueries({ queryKey: [name] });
      return;
    case "changed":
      if (event.status !== null) {
        const status = event.status;
        client.setQueryData(pullRequestStatusQuery.queryKey, (previous) =>
          new Map(previous).set(statusKey(status.accountId, status.key), status),
        );
      }
      for (const queryKey of pullRequestQueryKeys(event.key, event.accountId))
        void client.invalidateQueries({ queryKey });
      return;
    case "inbox":
      void client.invalidateQueries({ queryKey: inboxQuery.queryKey });
      return;
    case "stack":
      void client.invalidateQueries({ queryKey: ["pullRequestStack", event.accountId] });
      return;
    case "repositories":
      void client.invalidateQueries({ queryKey: repositoriesQuery.queryKey });
      void client.invalidateQueries({ queryKey: ["repositoryPullRequests"] });
      return;
  }
};

/**
 * Listens to the server's GitHub caches while the window is visible. Holding the
 * stream open is also what tells the server to keep open PR tabs current; a hidden
 * window lets go of it, so prkit stops reading GitHub for tabs nobody sees.
 */
export function useGitHubEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const apply = applyTo(client);
    let stop: (() => void) | null = null;
    let opened = 0;
    const sync = () => {
      if (document.visibilityState === "visible") {
        stop ??= watchGitHub((event) => {
          if (event._tag === "opened") opened++;
          apply(event, opened > 1);
        });
        return;
      }
      stop?.();
      stop = null;
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop?.();
    };
  }, [client]);
}
