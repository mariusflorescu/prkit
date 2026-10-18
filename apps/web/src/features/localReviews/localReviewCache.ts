import {
  applyWorkspaceCommand,
  type LocalReviewFeedEvent,
  type LocalReviewKey,
  type LocalReviewSnapshot,
  type LocalReviewWatchEvent,
  type ReviewId,
} from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { mergeActivity } from "~/components/review/reviewCache";
import { localReviewQuery, localReviewsQuery, workspaceQuery } from "~/rpc/queries";

/** What a removed review reads as: no review, so its page says it is gone. */
const gone = (key: LocalReviewKey): LocalReviewSnapshot => ({
  key,
  review: null,
  attempt: null,
  revisions: [],
  activity: [],
  run: null,
});

const lastLine = (snapshot: LocalReviewSnapshot) => snapshot.activity.at(-1)?.id ?? 0;

/** A command's answer can land after a newer streamed update; the newer one stays. */
const isOlder = (incoming: LocalReviewSnapshot, current: LocalReviewSnapshot | undefined) => {
  if (current?.review == null || incoming.review === null) return false;
  if (incoming.review.updatedAt !== current.review.updatedAt)
    return incoming.review.updatedAt < current.review.updatedAt;
  return incoming.attempt?.id === current.attempt?.id && lastLine(incoming) < lastLine(current);
};

/** Reviews removed while this window was open: a late answer about one never brings it back. */
const removed = new Set<ReviewId>();
const isRemoved = (snapshot: LocalReviewSnapshot) =>
  snapshot.review !== null && removed.has(snapshot.review.id);

export const storeLocalSnapshot = (client: QueryClient, snapshot: LocalReviewSnapshot) => {
  if (isRemoved(snapshot)) return;
  client.setQueryData(localReviewQuery(snapshot.key).queryKey, (current) =>
    isOlder(snapshot, current) ? current : snapshot,
  );
};

/** Drops a removed review from the list, the strip and its page, here and in every window. */
export const forgetLocalReview = (client: QueryClient, key: LocalReviewKey) => {
  const review = client.getQueryData(localReviewQuery(key).queryKey)?.review;
  if (review != null) removed.add(review.id);
  void client.cancelQueries({ queryKey: localReviewQuery(key).queryKey });
  // Its guides, drafts and diffs go too: a review made again for the branch starts at revision 1.
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "localReview" && query.queryKey[1] === key,
  });
  client.setQueryData(localReviewsQuery.queryKey, (current) =>
    current?.filter((entry) => entry.key !== key),
  );
  client.setQueryData(workspaceQuery.queryKey, (current) =>
    current === undefined ? current : applyWorkspaceCommand(current, { kind: "close-local", key }),
  );
  client.setQueryData(localReviewQuery(key).queryKey, gone(key));
};

export const applyLocalReviewEvent = (
  client: QueryClient,
  key: LocalReviewKey,
  event: LocalReviewWatchEvent,
) => {
  switch (event._tag) {
    case "snapshot":
      // A watch that opens on no review (removed while the window was away) drops its tab too.
      if (event.snapshot.review === null) forgetLocalReview(client, key);
      else if (!isRemoved(event.snapshot))
        client.setQueryData(localReviewQuery(key).queryKey, event.snapshot);
      return;
    case "update":
      if (removed.has(event.review.id)) return;
      client.setQueryData(localReviewQuery(key).queryKey, (current) => ({
        key,
        review: event.review,
        attempt: event.attempt,
        revisions: event.revisions,
        activity: mergeActivity(current, event),
        run: event.run,
      }));
      return;
    case "removed":
      forgetLocalReview(client, key);
  }
};

/** The app-wide list, newest first, from `localReviews.feed`; `ready` is the notifier's. */
export const applyLocalFeedEvent = (client: QueryClient, event: LocalReviewFeedEvent) => {
  switch (event._tag) {
    case "index":
      client.setQueryData(localReviewsQuery.queryKey, event.reviews);
      return;
    case "changed":
      client.setQueryData(localReviewsQuery.queryKey, (current) =>
        [
          event.review,
          ...(current ?? []).filter((entry) => entry.key !== event.review.key),
        ].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
      return;
    case "removed":
      forgetLocalReview(client, event.key);
      return;
    case "ready":
      return;
  }
};
