import type {
  AttemptSummary,
  PullRequestKey,
  ReviewActivity,
  ReviewSnapshot,
  ReviewWatchEvent,
} from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { pullRequestDetailQuery, reviewQuery } from "~/rpc/queries";

const MAX_LINES = 200;

const lastLine = (snapshot: ReviewSnapshot) => snapshot.activity.at(-1)?.id ?? 0;

/** Server reads are fresh when made, but can land after a newer streamed update. */
const isOlder = (incoming: ReviewSnapshot, current: ReviewSnapshot | undefined) => {
  if (current?.review == null || incoming.review === null) return false;
  if (incoming.review.updatedAt !== current.review.updatedAt)
    return incoming.review.updatedAt < current.review.updatedAt;
  return incoming.attempt?.id === current.attempt?.id && lastLine(incoming) < lastLine(current);
};

type Progress = {
  readonly attempt: AttemptSummary | null;
  readonly activity: ReadonlyArray<ReviewActivity>;
};

/** The lines an update adds to those kept for its attempt; another attempt starts over. */
export const mergeActivity = (current: Progress | undefined, update: Progress) => {
  const attemptId = update.attempt?.id ?? null;
  const known = current?.attempt?.id === attemptId ? (current?.activity ?? []) : [];
  const seen = new Set(known.map((line) => line.id));
  const fresh = update.activity.filter(
    (line) => line.attemptId === attemptId && !seen.has(line.id),
  );
  return [...known, ...fresh].slice(-MAX_LINES);
};

/** Puts a whole snapshot (a `reviews.*` result or the stream's opening event) in the cache. */
export const storeSnapshot = (client: QueryClient, snapshot: ReviewSnapshot) =>
  client.setQueryData(reviewQuery(snapshot.key).queryKey, (current) =>
    isOlder(snapshot, current) ? current : snapshot,
  );

export const applyReviewEvent = (
  client: QueryClient,
  key: PullRequestKey,
  event: ReviewWatchEvent,
) => {
  if (event._tag === "snapshot") {
    client.setQueryData(reviewQuery(key).queryKey, event.snapshot);
    return;
  }
  const before = client.getQueryData(reviewQuery(key).queryKey);
  // The watcher saw the PR change (merged, closed, new head), so its header is stale too.
  const ended = event.review.status._tag === "done" && before?.review?.status._tag !== "done";
  const revised = event.revisions.length !== (before?.revisions.length ?? 0);
  if (ended || revised) {
    // The watcher's fingerprint already marked the server's detail stale.
    void client.invalidateQueries({
      queryKey: pullRequestDetailQuery(key, event.review.accountId).queryKey,
    });
  }
  client.setQueryData(reviewQuery(key).queryKey, (current) => ({
    key,
    review: event.review,
    attempt: event.attempt,
    revisions: event.revisions,
    activity: mergeActivity(current, event),
  }));
};
