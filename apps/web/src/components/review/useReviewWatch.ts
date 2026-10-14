import type { PullRequestKey } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchReview } from "~/rpc/client";

import { applyReviewEvent } from "./reviewCache";

/** One stream per PR however many components follow it (the sidebar row and the Guide tab). */
const subscriptions = new Map<PullRequestKey, { count: number; stop: () => void }>();

/** Keeps `reviewQuery(key)` current while the calling component is mounted. */
export function useReviewWatch(key: PullRequestKey) {
  const client = useQueryClient();
  useEffect(() => {
    const existing = subscriptions.get(key);
    const entry = existing ?? {
      count: 0,
      stop: watchReview(key, (event) => applyReviewEvent(client, key, event)),
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
