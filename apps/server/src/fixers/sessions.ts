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
import { RepoCache } from "../repo/RepoCache.ts";
import {
  decodeTurns,
  encodeOptions,
  type FixerRow,
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const {
      appendActivity,
      contextDir,
      dbFailures,
      findFixer,
      fixerById,
      newId,
      now,
      publish,
      returnDrafts,
      runId,
      snapshotOf,
      transition,
      turnsOf,
      watched,
    } = state;
    const { advance, stopFiber } = queue;

    /**
     * The fixer for a PR, created or brought back with the agent given; an instance in another
     * conversation group (another kind or config folder) starts a new conversation.
     */
    const ensureFixer = (
      key: PullRequestKey,
      accountId: AccountId,
      agent: {
        readonly instance: AgentInstanceId;
        readonly provider: AgentProviderKind;
        readonly model: string | null;
        readonly options: AgentSelection["options"];
      },
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
            ended = NULL, updated_at = excluded.updated_at`;
        const fixer = yield* findFixer(key);
        if (fixer === null)
          return yield* new FixerError({
            message: "prkit couldn't save the agent session. Try again.",
          });
        return fixer;
      });

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

    /** Drops a turn: a running agent stops, a ready commit goes, the drafts come back. Nothing reached GitHub. */
    const dropTurn = (
      fixer: FixerRow,
      row: TurnRow,
      status: Extract<FixerTurnStatus, { _tag: "discarded" }>,
    ) =>
      Effect.gen(function* () {
        if (!(yield* transition(row.id, DROPPABLE, status))) return false;
        yield* stopFiber(row.id);
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
        yield* returnDrafts(row.id);
        yield* appendActivity(fixer.pr_key, row.id, "note", status.message);
        return true;
      });

    /**
     * Ends the session: done(reason), queued and running turns dropped, a ready
     * commit discarded, drafts back with the owner, the checkout removed. Turns
     * already pushing finish their push. The Stop command and the watcher both come here.
     */
    const end = (key: PullRequestKey, reason: DoneReason) =>
      Effect.gen(function* () {
        const fixer = yield* findFixer(key);
        if (fixer === null || fixer.ended !== null) return;
        const at = yield* now;
        const ended = yield* sql`UPDATE fixers SET ended = ${reason}, updated_at = ${at}
          WHERE id = ${fixer.id} AND ended IS NULL RETURNING id`;
        if (ended.length === 0) return;
        for (const row of yield* turnsOf(fixer.id, DROPPABLE))
          yield* dropTurn(fixer, row, {
            _tag: "discarded",
            reason: "ended",
            message: ENDED[reason],
          });
        yield* repo
          .removeFixer(fixer.id, refFromKey(fixer.pr_key))
          .pipe(Effect.catchTag("RepoError", (error) => Effect.logWarning(error.message)));
        yield* Effect.logInfo("Fix session ended").pipe(
          Effect.annotateLogs({ fixerId: fixer.id, reason }),
        );
        yield* publish(key);
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
     * and the next push finds out whether it landed. Checkouts of ended sessions are
     * removed and queues advance. A second run changes nothing.
     */
    const reconcile = Effect.gen(function* () {
      const stale = yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
        WHERE json_extract(status, '$._tag') IN ('preparing', 'running', 'pushing')
          AND (run_id IS NULL OR run_id != ${runId})`.pipe(Effect.flatMap(decodeTurns));
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
        const fixer = yield* fixerById(row.fixer_id);
        if (fixer === null) continue;
        const ref = refFromKey(fixer.pr_key);
        if (end._tag === "unfinished") {
          yield* leftovers.record(row.id, end);
          const message = `prkit stopped while the agent was working, and couldn't make sure that everything the agent started has ended (${end.reason}). Nothing was committed or pushed. Retry to run it again.`;
          if (
            yield* transition(row.id, ["preparing", "running"], {
              _tag: "failed",
              reason: "checks",
              message,
            })
          ) {
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
          yield* returnDrafts(row.id);
          if (ref !== null && row.head_sha !== null)
            yield* leftovers
              .unlessLeftovers(fixer.id, repo.resetFix(ref, fixer.id, row.head_sha))
              .pipe(Effect.ignore);
          yield* appendActivity(fixer.pr_key, row.id, "error", message);
        }
      }
      const live = new Set((yield* watched).map((fixer) => fixer.id));
      let removed = 0;
      for (const name of yield* repo.listFixers()) {
        const fixerId = FixerId.make(name);
        if (live.has(fixerId)) continue;
        // The cache to prune comes from prkit's own record of the fixer, never the checkout.
        const row = yield* fixerById(fixerId);
        const ref = row === null ? null : refFromKey(row.pr_key);
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

    return { ensureFixer, boundFixer, dropTurn, end, stop, reconcile };
  });

export type Sessions = Effect.Success<ReturnType<typeof makeSessions>>;
