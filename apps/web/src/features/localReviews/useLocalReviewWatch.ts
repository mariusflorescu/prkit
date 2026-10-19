import type { LocalReviewKey } from "@prkit/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { watchLocalReview } from "~/rpc/client";
import { localReviewProblemQuery } from "~/rpc/queries";

import { applyLocalReviewEvent } from "./localReviewCache";

/** One stream per local review however many components follow it (its tab and its page). */
const subscriptions = new Map<
  LocalReviewKey,
  { count: number; stop: () => void; retry: () => void }
>();

/**
 * Keeps `localReviewQuery(key)` current while the calling component is mounted. `problem` says
 * why prkit can't, until it can again; `retry` tries again now.
 */
export function useLocalReviewWatch(key: LocalReviewKey) {
  const client = useQueryClient();
  useEffect(() => {
    const { queryKey } = localReviewProblemQuery(key);
    const entry = subscriptions.get(key) ?? {
      count: 0,
      ...watchLocalReview(
        key,
        (event) => {
          if (client.getQueryData(queryKey) != null) client.setQueryData(queryKey, null);
          applyLocalReviewEvent(client, key, event);
        },
        (message) => client.setQueryData(queryKey, message),
      ),
    };
    entry.count++;
    subscriptions.set(key, entry);
    return () => {
      entry.count--;
      if (entry.count > 0) return;
      entry.stop();
      subscriptions.delete(key);
    };
  }, [client, key]);
  const problem = useQuery(localReviewProblemQuery(key)).data ?? null;
  const retry = useCallback(() => subscriptions.get(key)?.retry(), [key]);
  return { problem, retry };
}
