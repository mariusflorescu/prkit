import type { AccountId, PendingComments, PullRequestKey, ReviewThreads } from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { pendingCommentsQuery, reviewThreadsQuery } from "~/rpc/queries";

/** Every comment mutation answers with the PR's current list, written straight into the cache. */
export const storePending =
  (client: QueryClient, key: PullRequestKey, accountId: AccountId) => (comments: PendingComments) =>
    client.setQueryData(pendingCommentsQuery(key, accountId).queryKey, comments);

export const storeThreads =
  (client: QueryClient, key: PullRequestKey, accountId: AccountId) => (threads: ReviewThreads) =>
    client.setQueryData(reviewThreadsQuery(key, accountId).queryKey, threads);
