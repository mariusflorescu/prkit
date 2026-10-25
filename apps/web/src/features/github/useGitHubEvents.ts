import type { AccountBinding, AccountId, GitHubEvent, PullRequestStatus } from "@prkit/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { forgetMovedAccounts } from "~/features/accounts/forgetMovedAccounts";
import { watchGitHub } from "~/rpc/client";
import {
  accountsQuery,
  pullRequestQueryKeys,
  pullRequestStatusQuery,
  readInboxAgain,
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

/** The server's statuses replace this window's, so none read through a directory left behind stays. */
const showStatuses = (client: QueryClient, statuses: ReadonlyArray<PullRequestStatus>) =>
  client.setQueryData(
    pullRequestStatusQuery.queryKey,
    new Map(statuses.map((status) => [statusKey(status.accountId, status.key), status])),
  );

const applyTo =
  (
    client: QueryClient,
    rebind: (bindings: ReadonlyArray<AccountBinding>) => ReadonlyArray<AccountId>,
  ) =>
  (event: GitHubEvent, reopened: boolean) => {
    switch (event._tag) {
      case "opened":
        // A discovery while this window wasn't listening shows up here, against what it heard last.
        if (event.bindings !== null && rebind(event.bindings).length > 0)
          void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
        showStatuses(client, event.statuses);
        // The inbox's first answer may have started reads that landed before this opened.
        readInboxAgain(client);
        if (!reopened) return;
        // Changes made while this window was hidden or offline were never sent; the
        // server answers these from its cache unless GitHub really changed.
        for (const name of PULL_REQUEST_READS) void client.invalidateQueries({ queryKey: [name] });
        return;
      case "accounts":
        rebind(event.bindings);
        showStatuses(client, event.statuses);
        void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
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
        readInboxAgain(client);
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
    const accounts = forgetMovedAccounts(client);
    const apply = applyTo(client, accounts.rebind);
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
      accounts.stop();
    };
  }, [client]);
}
