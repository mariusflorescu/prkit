import type { PullRequestKey } from "@prkit/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchFixer } from "~/rpc/client";

import { storeFixer } from "./fixerCache";

/** One stream per PR however many components follow it (the header button and the Fixes tab). */
const subscriptions = new Map<PullRequestKey, { count: number; stop: () => void }>();

/** Keeps `fixerQuery(key)` current while the calling component is mounted. */
export function useFixerWatch(key: PullRequestKey) {
  const client = useQueryClient();
  useEffect(() => {
    const entry = subscriptions.get(key) ?? {
      count: 0,
      stop: watchFixer(key, (snapshot) => storeFixer(client, snapshot)),
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
