import {
  type AccountId,
  type AgentInstanceId,
  type AgentProviderKind,
  type AgentSelection,
  type DoneReason,
  FixerError,
  FixerId,
  FixerStateError,
  type FixerTurnState,
  type FixerTurnStatus,
  type PullRequestKey,
  refFromKey,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { reapAgentGroup } from "../agents/agentProcess.ts";
import { Agents } from "../agents/Agents.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import { makeE2eHold } from "../e2eHold.ts";
import { RepoCache } from "../repo/RepoCache.ts";
import { makeAgentChoice } from "./agentChoice.ts";
import {
  decodeEachFixer,
  decodeTurnStates,
  encodeOptions,
  encodeStatus,
  type FixerRow,
  readableTurns,
  TURN_COLUMNS,
  type TurnRow,
} from "./fixerRows.ts";
import type { FixerState } from "./fixerState.ts";
import { type TurnLeftovers, turnSince } from "./turnLeftovers.ts";
import type { TurnQueue } from "./turnQueue.ts";

const ENDED: Record<DoneReason, string> = {
  merged: "The pull request was merged",
  closed: "The pull request was closed",
  stopped: "Stopped the agent",
};
/** States a turn holds work from; discarding or ending the session drops them. */
export const DROPPABLE: ReadonlyArray<FixerTurnState> = ["queued", "preparing", "running", "ready"];

/**
 * A PR's fix session from start to end (docs/internals/fix-agent.md "Sessions and
 * turns", "Restarts"): created or brought back with an agent, bound to its account,
 * ended by Stop or the watcher, and reconciled after a restart.
 */
export const makeSessions = (state: FixerState, queue: TurnQueue, leftovers: TurnLeftovers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* RepoCache;
    const agents = yield* Agents;
    const { chooseAgent, chooseAgentOrKeep } = yield* makeAgentChoice;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hold = yield* makeE2eHold;
    const {
      appendActivity,
      contextDir,
      dbFailures,
      findFixer,
      newId,
      now,
      publish,
      recordActivity,
      returnDrafts,
      runId,
      snapshotOf,
      transition,
      unreadableTurns,
    } = state;
    const { advance, stopFiber, whileEnding } = queue;

    /**
     * The fixer for a PR on the agent given, created if there is none, and brought back if it
     * ended when `reopen`; an instance in another conversation group (another kind or config
     * folder) starts a new conversation.
     */
    const saveFixer = (
      key: PullRequestKey,
      accountId: AccountId,
      agent: {
        readonly instance: AgentInstanceId;
        readonly provider: AgentProviderKind;
        readonly model: string | null;
        readonly options: AgentSelection["options"];
      },
      reopen: boolean,
    ) =>
      Effect.gen(function* () {
        const at = yield* now;
        const id = FixerId.make(yield* newId);
        const sameGroup = yield* agents.sameGroup(agent.instance);
        yield* sql`
          INSERT INTO fixers (id, pr_key, account_id, provider, instance_id, model, model_options,
            created_at, updated_at)
          VALUES (${id}, ${key}, ${accountId}, ${agent.provider}, ${agent.instance}, ${agent.model},
            ${encodeOptions(agent.options)}, ${at}, ${at})
          ON CONFLICT (pr_key) DO UPDATE SET
            session_id = CASE WHEN fixers.instance_id IN ${sql.in(sameGroup)} THEN fixers.session_id ELSE NULL END,
            provider = excluded.provider, instance_id = excluded.instance_id, model = excluded.model,
            model_options = excluded.model_options,
            ended = CASE WHEN ${reopen ? 1 : 0} = 1 THEN NULL ELSE fixers.ended END,
            updated_at = excluded.updated_at`;
        const fixer = yield* findFixer(key);
        if (fixer === null)
          return yield* new FixerError({
            message: "prkit couldn't save the agent session.",
          });
        return fixer;
      });
    /** Sending, resolving conflicts, reverting or retrying starts the session, or brings it back after it ended. */
    const ensureFixer = (
      key: PullRequestKey,
      accountId: AccountId,
      agent: Parameters<typeof saveFixer>[2],
    ) => saveFixer(key, accountId, agent, true);

    /**
     * The session on `agent`: unchanged when it is already the session's. It never brings back a
     * session that ended, so a turn that only rebinds can't undo a Stop.
     */
    const moveTo = (fixer: FixerRow, agent: Effect.Success<ReturnType<typeof chooseAgent>>) =>
      Effect.gen(function* () {
        if (agent.instance === fixer.instance_id) return fixer;
        yield* Effect.logInfo("Moved a fix session off an agent that is off").pipe(
          Effect.annotateLogs({ fixerId: fixer.id, from: fixer.instance_id, to: agent.instance }),
        );
        return yield* saveFixer(fixer.pr_key, fixer.account_id, agent, false);
      });
    /**
     * The session as a turn nobody picked an agent for runs it (a redo, a retry, a change
     * request): moved to the agent `chooseAgent` falls back to when its own instance is off or
     * was removed, so it never runs on a setup the user turned off.
     */
    const rebind = (fixer: FixerRow) =>
      chooseAgent(undefined, fixer).pipe(Effect.flatMap((agent) => moveTo(fixer, agent)));
    /** `rebind`, keeping the session's own agent when none is ready: for a turn that may run none. */
    const rebindOrKeep = (fixer: FixerRow) =>
      chooseAgentOrKeep(fixer).pipe(Effect.flatMap((agent) => moveTo(fixer, agent)));

    /** The account check every command shares: a PR's agent works through the account bound to it. */
    const boundFixer = (key: PullRequestKey, accountId: AccountId) =>
      Effect.gen(function* () {
        if (refFromKey(key) === null)
          return yield* new FixerError({ message: "That doesn't look like a pull request." });
        const fixer = yield* findFixer(key);
        if (fixer !== null && fixer.account_id !== accountId)
          return yield* new FixerError({
            message: `This pull request's agent works through ${fixer.account_id}. Open it through that account.`,
          });
        return fixer;
      });

    /**
     * A turn's drop in the database: its state, its drafts back with the owner and its note,
     * together in the caller's transaction. It stays unfinished, so it holds the checkout, until
     * `finishDrop` has done the rest; startup finishes a drop a crash cut off.
     */
    const discard = (
      row: TurnRow,
      status: Extract<FixerTurnStatus, { _tag: "discarded" }>,
      from: ReadonlyArray<FixerTurnState>,
      /** Only a turn no change request ever ran on (`rounds = 0`). */
      freshOnly: boolean,
    ) =>
      Effect.gen(function* () {
        const dropped = yield* sql`UPDATE fixer_turns SET status = ${encodeStatus(status)}
          WHERE id = ${row.id} AND json_extract(status, '$._tag') IN ${sql.in(from)}
            AND (${freshOnly ? 1 : 0} = 0 OR rounds = 0) RETURNING id`;
        if (dropped.length === 0) return false;
        yield* returnDrafts(row.id);
        yield* recordActivity(row.id, "note", status.message);
        return true;
      });

    /** The rest of a drop once its agent is stopped: the checkout back at the head, the commit let go, the turn finished. */
    const finishDrop = (fixer: FixerRow, row: TurnRow) =>
      Effect.gen(function* () {
        const ref = refFromKey(fixer.pr_key);
        if (ref !== null && row.head_sha !== null)
          yield* leftovers
            .unlessLeftovers(fixer.id, repo.resetFix(ref, fixer.id, row.head_sha))
            .pipe(
              Effect.catchTags({
                RepoError: (error) => Effect.logWarning(error.message),
                PlatformError: () => Effect.void,
              }),
            );
        if (ref !== null) yield* repo.holdCommit(ref, row.id, null).pipe(Effect.ignore);
        const at = yield* now;
        yield* sql`UPDATE fixer_turns SET finished_at = ${at} WHERE id = ${row.id} AND finished_at IS NULL`;
      });

    /** Drops a turn: a running agent stops, a ready commit goes, the drafts come back. Nothing reached GitHub. */
    const dropTurn = (
      fixer: FixerRow,
      row: TurnRow,
      status: Extract<FixerTurnStatus, { _tag: "discarded" }>,
      from: ReadonlyArray<FixerTurnState> = DROPPABLE,
      freshOnly = false,
    ) =>
      // Once the drop is stored, the rest runs even when its caller goes away (a closed window).
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!(yield* sql.withTransaction(discard(row, status, from, freshOnly)))) return false;
          yield* stopFiber(row.id);
          yield* finishDrop(fixer, row);
          yield* publish(fixer.pr_key);
          return true;
        }),
      );

    /**
     * Ends the session: done(reason), queued and running turns dropped, a ready
     * commit discarded, drafts back with the owner, the checkout removed. Turns
     * already pushing finish their push, and never redo it. The Stop command and the
     * watcher both come here.
     */
    const end = (key: PullRequestKey, reason: DoneReason) =>
      Effect.gen(function* () {
        const fixer = yield* findFixer(key);
        if (fixer === null || fixer.ended !== null) return;
        const status = { _tag: "discarded", reason: "ended", message: ENDED[reason] } as const;
        const body = Effect.gen(function* () {
          // The session ends with every turn it drops, or, when a save fails, not at all.
          const dropped = yield* sql.withTransaction(
            Effect.gen(function* () {
              const at = yield* now;
              const ended = yield* sql`UPDATE fixers SET ended = ${reason}, updated_at = ${at}
                WHERE id = ${fixer.id} AND ended IS NULL RETURNING id`;
              if (ended.length === 0) return null;
              // A turn prkit can't read stays as it was; the others end with the session.
              const droppable = yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
                WHERE fixer_id = ${fixer.id} AND json_extract(status, '$._tag') IN ${sql.in(DROPPABLE)}
                ORDER BY created_at, rowid`.pipe(Effect.flatMap(readableTurns));
              for (const row of droppable) yield* discard(row, status, DROPPABLE, false);
              // A push in flight finishes, but is never redone.
              yield* sql`UPDATE fixer_turns SET status = json_set(status, '$.spared', json('true'))
                WHERE fixer_id = ${fixer.id} AND json_extract(status, '$._tag') = 'pushing'`;
              return droppable;
            }),
          );
          if (dropped === null) return;
          yield* hold("fix-session-end");
          for (const row of dropped) {
            yield* stopFiber(row.id);
            yield* finishDrop(fixer, row);
          }
          yield* (yield* unreadableTurns(fixer.id)).length > 0
            ? Effect.logWarning("Kept the fix checkout: a turn prkit can't read may still be in it")
            : repo
                .removeFixer(fixer.id, refFromKey(fixer.pr_key))
                .pipe(Effect.catchTag("RepoError", (error) => Effect.logWarning(error.message)));
          yield* Effect.logInfo("Fix session ended").pipe(
            Effect.annotateLogs({ fixerId: fixer.id, reason }),
          );
          yield* publish(key);
        });
        // As in `dropTurn`: once the end is stored, the rest runs even when its caller goes away.
        yield* whileEnding(fixer.id, Effect.uninterruptible(body));
      });

    const stop = (key: PullRequestKey) =>
      Effect.gen(function* () {
        const fixer = yield* findFixer(key);
        if (fixer === null)
          return yield* new FixerStateError({
            key,
            message: "No agent works on this pull request.",
          });
        yield* end(key, "stopped");
        return yield* snapshotOf(key);
      }).pipe(Effect.catchTags(dbFailures));

    /**
     * Startup (docs/internals/fix-agent.md "Restarts"): turns an earlier run left
     * working become failed(interrupted) and their drafts go back; a change request
     * cut off returns to the result it changed; a push cut off goes back to ready,
     * and the next push finds out whether it landed; a drop cut off (a discard, or a
     * session's end) finishes. Checkouts of ended sessions are removed and queues
     * advance. A second run changes nothing.
     */
    const reconcile = Effect.gen(function* () {
      // A turn whose state prkit can't read (a newer prkit's, or damaged) stays as it was:
      // guessing could lose its commit or redo a push. One that isn't JSON is quoted, so the
      // state filters on the table still read past it.
      const [, unreadableStates] = yield* sql`SELECT id, status FROM fixer_turns`.pipe(
        Effect.flatMap(decodeTurnStates),
      );
      for (const turn of unreadableStates) {
        yield* sql`UPDATE fixer_turns SET status = json_quote(status)
          WHERE id = ${turn.id} AND NOT json_valid(status)`;
        yield* Effect.logWarning("Left a fix turn whose state prkit can't read as it was").pipe(
          Effect.annotateLogs({ turnId: turn.id ?? "", problem: turn.problem }),
        );
      }
      const [fixers, unreadableFixers] = yield* sql`SELECT * FROM fixers`.pipe(
        Effect.flatMap(decodeEachFixer),
      );
      const known = new Map(fixers.map((fixer) => [fixer.id, fixer]));
      // Turns an earlier run left working, and drops a crash cut off before they finished.
      const stale = yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
        WHERE (json_extract(status, '$._tag') IN ('preparing', 'running', 'pushing')
            OR (json_extract(status, '$._tag') = 'discarded' AND finished_at IS NULL))
          AND (run_id IS NULL OR run_id != ${runId})`.pipe(Effect.flatMap(readableTurns));
      for (const row of stale) {
        // An agent outlives a killed server; stop it before anything resumes its session.
        if (row.agent_pid !== null && row.agent_started !== null) {
          const reaped = yield* reapAgentGroup(row.agent_pid, row.agent_started).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          if (reaped)
            yield* Effect.logInfo("Stopped an agent the previous run left behind").pipe(
              Effect.annotateLogs({ turnId: row.id, pid: row.agent_pid }),
            );
        }
        // What prkit can still tie to the turn ends too, by the mark its processes carry, before
        // anything here or a Retry runs git in its checkout (fix-agent doc, "Turn end").
        const end =
          row.status._tag === "pushing"
            ? ({ _tag: "ended" } as const)
            : yield* leftovers.sweep(row.id, turnSince(row));
        const fixer = known.get(row.fixer_id);
        if (fixer === undefined) continue;
        const ref = refFromKey(fixer.pr_key);
        if (end._tag === "unfinished") yield* leftovers.record(row.id, end);
        if (row.status._tag === "discarded") {
          yield* finishDrop(fixer, row);
          continue;
        }
        if (end._tag === "unfinished") {
          const message = `prkit stopped while the agent was working, and couldn't make sure that everything the agent started has ended (${end.reason}). Nothing was committed or pushed. Retry to run it again.`;
          if (
            yield* transition(row.id, ["preparing", "running"], {
              _tag: "failed",
              reason: "checks",
              message,
            })
          ) {
            yield* hold("fix-turn-end");
            yield* returnDrafts(row.id);
            yield* appendActivity(fixer.pr_key, row.id, "error", message);
          }
          continue;
        }
        if (row.status._tag === "pushing") {
          if (yield* transition(row.id, ["pushing"], { _tag: "ready" }))
            yield* appendActivity(
              fixer.pr_key,
              row.id,
              "note",
              "prkit stopped during the push. Push again: prkit checks the branch first",
            );
          continue;
        }
        if (row.status._tag === "running" && row.commit_sha !== null) {
          if (ref !== null)
            yield* leftovers
              .unlessLeftovers(fixer.id, repo.resetFix(ref, fixer.id, row.commit_sha))
              .pipe(Effect.ignore);
          if (yield* transition(row.id, ["running"], { _tag: "ready" }))
            yield* appendActivity(
              fixer.pr_key,
              row.id,
              "error",
              "prkit stopped while the agent was changing this. The earlier result is unchanged",
            );
          continue;
        }
        const message = "prkit stopped while the agent was working. Retry to run it again.";
        if (
          yield* transition(row.id, ["preparing", "running"], {
            _tag: "failed",
            reason: "interrupted",
            message,
          })
        ) {
          yield* hold("fix-turn-end");
          yield* returnDrafts(row.id);
          if (ref !== null && row.head_sha !== null)
            yield* leftovers
              .unlessLeftovers(fixer.id, repo.resetFix(ref, fixer.id, row.head_sha))
              .pipe(Effect.ignore);
          yield* appendActivity(fixer.pr_key, row.id, "error", message);
        }
      }
      const live = new Set(fixers.filter((fixer) => fixer.ended === null).map((fixer) => fixer.id));
      // A fixer whose record can't be read, or with a turn whose state can't be read, may still
      // be working: its checkout stays.
      const kept = new Set(unreadableFixers.map((fixer) => fixer.id));
      let removed = 0;
      for (const name of yield* repo.listFixers()) {
        const fixerId = FixerId.make(name);
        if (live.has(fixerId) || kept.has(name)) continue;
        if ((yield* unreadableTurns(fixerId)).length > 0) continue;
        // The cache to prune comes from prkit's own record of the fixer, never the checkout.
        const row = known.get(fixerId);
        const ref = row === undefined ? null : refFromKey(row.pr_key);
        if (yield* repo.removeFixer(fixerId, ref).pipe(Effect.orElseSucceed(() => false)))
          removed++;
      }
      // Each turn's context is named after it, and its temp folder too (`turnTmpDir`).
      for (const name of yield* fs.readDirectory(contextDir)) {
        yield* fs.remove(turnTmpDir(path, name), { recursive: true, force: true });
        yield* fs.remove(path.join(contextDir, name), { recursive: true, force: true });
      }
      for (const id of live) yield* advance(id);
      yield* Effect.logInfo("Reconciled fix sessions").pipe(
        Effect.annotateLogs({ interrupted: stale.length, worktreesRemoved: removed }),
      );
    });

    return {
      chooseAgent,
      chooseAgentOrKeep,
      ensureFixer,
      rebind,
      rebindOrKeep,
      boundFixer,
      discard,
      finishDrop,
      dropTurn,
      end,
      stop,
      reconcile,
    };
  });

export type Sessions = Effect.Success<ReturnType<typeof makeSessions>>;
