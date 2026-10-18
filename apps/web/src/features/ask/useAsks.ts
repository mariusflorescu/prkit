import type { ReviewId } from "@prkit/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { watchAsks } from "~/rpc/client";
import { type AsksState, asksQuery } from "~/rpc/queries";

import { applyAskEvent, asksFailed } from "./askEvents";

const loading: AsksState = { _tag: "loading" };

/** One stream per review however many components show its questions (the dock and the pins). */
const subscriptions = new Map<ReviewId, { count: number; stop: () => void }>();

const follow = (client: QueryClient, reviewId: ReviewId) => {
  const { queryKey } = asksQuery(reviewId);
  return watchAsks(
    reviewId,
    (event) => client.setQueryData(queryKey, (state) => applyAskEvent(state ?? loading, event)),
    (message) => client.setQueryData(queryKey, (state) => asksFailed(state, message)),
  );
};

/** A review's questions, kept current while the calling component is mounted. */
export function useAsks(reviewId: ReviewId) {
  const client = useQueryClient();
  useEffect(() => {
    const entry = subscriptions.get(reviewId) ?? { count: 0, stop: follow(client, reviewId) };
    entry.count++;
    subscriptions.set(reviewId, entry);
    return () => {
      entry.count--;
      if (entry.count > 0) return;
      entry.stop();
      subscriptions.delete(reviewId);
    };
  }, [client, reviewId]);
  const query = useQuery(asksQuery(reviewId));
  /** Follows again now instead of at the stream's next try. */
  const retry = useCallback(() => {
    const entry = subscriptions.get(reviewId);
    if (entry === undefined) return;
    entry.stop();
    client.setQueryData(asksQuery(reviewId).queryKey, (state) =>
      state?._tag === "ready" ? state : loading,
    );
    entry.stop = follow(client, reviewId);
  }, [client, reviewId]);
  return { state: query.data ?? loading, retry };
}
