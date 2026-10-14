import type { PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fixerFeedQuery, fixerQuery } from "~/rpc/queries";

/** How long the page waits for the feed's index before treating the PR as having no fixes. */
const FEED_WAIT_MS = 3_000;

/**
 * Whether anything was ever sent to this PR's fix agent, so it has a Fixes tab:
 * `undefined` until the feed's index arrives, for at most `FEED_WAIT_MS`. The feed
 * retries quietly when it fails, so after that the answer is `false` until it arrives.
 * A session the client already holds (a send or a resolution that just returned)
 * counts before the feed says so.
 */
export const useHasFixes = (key: PullRequestKey) => {
  const feed = useQuery(fixerFeedQuery);
  // Reads what Send to agent and Resolve conflicts stored; never fetches it here.
  const session = useQuery({ ...fixerQuery(key), enabled: false });
  const waiting = feed.data === undefined;
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setGaveUp(true), FEED_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  if ((session.data?.turns.length ?? 0) > 0) return true;
  if (feed.data === undefined) return gaveUp ? false : undefined;
  return (feed.data.get(key)?.turns ?? 0) > 0;
};
