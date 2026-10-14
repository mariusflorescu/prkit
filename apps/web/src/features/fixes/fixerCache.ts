import type { FixerSnapshot } from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { invalidatePullRequestReads } from "~/features/github/pullRequestReads";
import { fixerQuery, pendingCommentsQuery } from "~/rpc/queries";

const states = (snapshot: FixerSnapshot | undefined) =>
  new Map((snapshot?.turns ?? []).map((turn) => [turn.id, turn.status._tag]));

/**
 * Writes a fix session snapshot into the cache and refreshes what a turn moving on
 * changes elsewhere: drafts go to the agent and come back, a push moves the PR's head.
 */
export const storeFixer = (client: QueryClient, snapshot: FixerSnapshot) => {
  const options = fixerQuery(snapshot.key);
  const before = states(client.getQueryData(options.queryKey));
  client.setQueryData(options.queryKey, snapshot);
  const accountId = snapshot.fixer?.accountId;
  if (accountId === undefined) return;
  const moved = snapshot.turns.filter((turn) => before.get(turn.id) !== turn.status._tag);
  if (moved.length === 0) return;
  void client.invalidateQueries({
    queryKey: pendingCommentsQuery(snapshot.key, accountId).queryKey,
  });
  // A push, or a conflict that went away without one, means the PR itself changed.
  if (
    moved.some(
      (turn) =>
        turn.status._tag === "pushed" ||
        (turn.status._tag === "discarded" &&
          (turn.status.reason === "outside" || turn.status.reason === "upstream")),
    )
  )
    void invalidatePullRequestReads(client, snapshot.key, accountId);
};
