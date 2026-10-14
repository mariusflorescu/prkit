import type { AccountId, PullRequestKey } from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { refreshPullRequest } from "~/rpc/client";
import { pullRequestQueryKeys } from "~/rpc/queries";

/** Reads again what this window shows of the PR; the server answers from its cache when it can. */
export const invalidatePullRequestReads = (
  client: QueryClient,
  key: PullRequestKey,
  accountId: AccountId,
) =>
  Promise.all(
    pullRequestQueryKeys(key, accountId).map((queryKey) => client.invalidateQueries({ queryKey })),
  );

/** One click: the server forgets its answers for this PR, so what the window shows comes from GitHub. */
export const refreshPullRequestReads = async (
  client: QueryClient,
  key: PullRequestKey,
  accountId: AccountId,
) => {
  await refreshPullRequest(key, accountId);
  await invalidatePullRequestReads(client, key, accountId);
};
