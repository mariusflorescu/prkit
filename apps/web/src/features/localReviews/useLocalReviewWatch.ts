import type { LocalReviewKey } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchLocalReview } from "~/rpc/client";

import { applyLocalReviewEvent } from "./localReviewCache";

/** One stream per local review however many components follow it (its tab and its page). */
const subscriptions = new Map<LocalReviewKey, { count: number; stop: () => void }>();

/** Keeps `localReviewQuery(key)` current while the calling component is mounted. */
export function useLocalReviewWatch(key: LocalReviewKey) {
  const client = useQueryClient();
  useEffect(() => {
    const existing = subscriptions.get(key);
    const entry = existing ?? {
      count: 0,
      stop: watchLocalReview(key, (event) => applyLocalReviewEvent(client, key, event)),
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
}
