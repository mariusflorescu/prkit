import {
  type AccountId,
  type ConflictStrategy,
  type AgentSelection,
  FIXER_BUSY,
  type FixerError,
  type FixerSnapshot,
  type FixerStateError,
  type FixerTrigger,
  type PullRequestKey,
  refFromKey,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { decodeTurns, TURN_COLUMNS } from "./fixerRows.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { type FixerState, repositoryOf } from "./fixerState.ts";
import { DROPPABLE, type Sessions } from "./sessions.ts";
import type { TurnQueue } from "./turnQueue.ts";

/** A watcher read of one PR, for `observed`. */
export interface FixerObservation {
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
}

/**
 * What one fix watcher read does to a PR's session (docs/internals/fix-agent.md
 * "Races"). `resolveConflicts` is the Resolve conflicts command, started without a click.
 */
export const makeFixWatch = (
  state: FixerState,
  queue: TurnQueue,
  sessions: Sessions,
  resolveConflicts: (
    key: PullRequestKey,
    accountId: AccountId,
    input: { readonly agent?: AgentSelection; readonly strategy: ConflictStrategy },
    trigger: FixerTrigger,
  ) => Effect.Effect<FixerSnapshot, FixerError | FixerStateError>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* FixerSettingsStore;
    const { autoResolvesLeft, dbFailures, findFixer, turnsOf } = state;
    const { advance } = queue;
    const { dropTurn, end } = sessions;

    /**
     * Applies one watcher read (docs/internals/fix-agent.md "Races"): a merged or
     * closed PR ends the session; a PR that merges cleanly again drops a pending
     * resolution as resolved outside prkit; a conflicting PR in a repository that
     * resolves automatically gets a resolution, at most three a day.
     */
    const observed = (key: PullRequestKey, accountId: AccountId, observation: FixerObservation) =>
      Effect.gen(function* () {
        const fixer = yield* findFixer(key);
        if (observation.state !== "open") {
          if (fixer !== null && fixer.ended === null) yield* end(key, observation.state);
          return;
        }
        if (fixer !== null && fixer.ended === null && observation.mergeable === "mergeable") {
          for (const row of yield* turnsOf(fixer.id, DROPPABLE)) {
            if (row.work._tag !== "conflicts") continue;
            // Our own turn's head is still the PR's head: nothing happened outside prkit.
            if (row.head_sha === observation.headSha) continue;
            yield* dropTurn(fixer, row, {
              _tag: "discarded",
              reason: "outside",
              message: "Resolved outside prkit",
            });
            yield* Effect.logInfo("Conflicts resolved outside prkit").pipe(
              Effect.annotateLogs({ key, turnId: row.id }),
            );
          }
          yield* advance(fixer.id);
          return;
        }
        if (observation.mergeable !== "conflicting") return;
        const ref = refFromKey(key);
        if (ref === null || !(yield* settings.get(repositoryOf(ref))).resolveAutomatically) return;
        // Per PR, not per session: a stopped session keeps its turns and its daily count.
        if (fixer !== null) {
          const turns = yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
            WHERE fixer_id = ${fixer.id} AND kind = 'conflicts' ORDER BY created_at DESC, rowid DESC LIMIT 5`.pipe(
            Effect.flatMap(decodeTurns),
          );
          // Already resolving, or already tried on this very head: wait for the owner.
          if (
            turns.some(
              (turn) =>
                [...FIXER_BUSY, "queued"].includes(turn.status._tag) ||
                turn.head_sha === observation.headSha,
            )
          )
            return;
          if (!(yield* autoResolvesLeft(fixer.id))) return;
        }
        if (fixer !== null && fixer.account_id !== accountId) return;
        yield* resolveConflicts(key, accountId, { strategy: "merge" }, "auto").pipe(
          Effect.tap(() =>
            Effect.logInfo("Resolving conflicts automatically").pipe(Effect.annotateLogs({ key })),
          ),
          Effect.catchTags({
            FixerError: (error) =>
              Effect.logWarning("Couldn't resolve conflicts automatically").pipe(
                Effect.annotateLogs({ key, message: error.message }),
              ),
            FixerStateError: () => Effect.void,
          }),
        );
      }).pipe(Effect.catchTags(dbFailures));

    return { observed };
  });
