import {
  type FixerError,
  type FixerId,
  FixerStateError,
  type FixerTrigger,
  FixerTurnId,
  type FixerTurnState,
  refFromKey,
} from "@prkit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type { SchemaError } from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { Agents } from "../agents/Agents.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import { makeE2eHold } from "../e2eHold.ts";
import { McpTokens } from "../mcp/McpTokens.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import {
  type GitTampered,
  type LinkRefused,
  RepoCache,
  type RepoError,
} from "../repo/RepoCache.ts";
import { encodeStatus, encodeWork, type FixerRow, type WorkRequest } from "./fixerRows.ts";
import { decodeCount, type FixerState, TurnFailure } from "./fixerState.ts";
import type { TurnLeftovers } from "./turnLeftovers.ts";

/** The states a turn is stored in right before its fiber starts: a queued turn's start, a change request. */
const LAUNCHED: ReadonlySet<FixerTurnState> = new Set(["preparing", "running"]);
const unreadable = (message: string) => new TurnFailure({ reason: "agent", message });

type QueueInput = {
  readonly createdAt?: string;
  /** The outside agent the work comes from; the call's own `StartedBy` when absent. */
  readonly startedBy?: string | null;
  /** Writes anything else the turn needs, in the same transaction. */
  readonly prepare?: (turnId: FixerTurnId) => Effect.Effect<void, FixerError | SqlError>;
};

/** What a turn does once it holds the checkout and an agent slot. */
export type TurnBody = Effect.Effect<
  void,
  | TurnFailure
  | SchemaError
  | SqlError
  | PlatformError
  | RepoError
  | LinkRefused
  | GitTampered
  | FixerError
>;

/**
 * The turn queue: one turn per PR holds the checkout at a time, queued turns
 * start in order, and every turn runs in one of the app's two agent slots.
 * `runTurn` is what a queued turn does when it starts, once what earlier turns left has ended.
 */
export const makeTurnQueue = (
  state: FixerState,
  leftovers: TurnLeftovers,
  runTurn: (turnId: FixerTurnId) => TurnBody,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* RepoCache;
    const agents = yield* Agents;
    const tokens = yield* McpTokens;
    const scope = yield* Effect.scope;
    const hold = yield* makeE2eHold;
    const {
      appendActivity,
      awaiting,
      contextDir,
      fail,
      fixerById,
      newId,
      notify,
      now,
      publish,
      recordActivity,
      returnDrafts,
      runId,
      transition,
      turnById,
      turnsOf,
    } = state;
    const running = new Map<FixerTurnId, Fiber.Fiber<void>>();
    /** How many ends of each session are still stopping agents and cleaning up. */
    const endsRunning = new Map<FixerId, number>();

    /**
     * Runs a session's end with its queue held: no turn of the session starts until the end has
     * stopped its agents, finished its drops and removed the checkout, so a fix sent again
     * meanwhile waits and then starts on a fresh checkout. The queue goes on after.
     */
    const whileEnding = <A, E, R>(fixerId: FixerId, end: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => endsRunning.set(fixerId, (endsRunning.get(fixerId) ?? 0) + 1)),
        () => end,
        () =>
          Effect.sync(() => {
            const left = (endsRunning.get(fixerId) ?? 1) - 1;
            if (left === 0) endsRunning.delete(fixerId);
            else endsRunning.set(fixerId, left);
          }).pipe(Effect.andThen(advance(fixerId))),
      );

    /**
     * Starts a turn of a session: `claim` stores the turn's new state, in one transaction with
     * the check that the session is live and no end of it is still cleaning up, and returns what
     * the turn runs, or null when there is nothing to start. Once the claim is stored, the turn's
     * run starts even when the caller goes away. Says why nothing started otherwise.
     */
    const start = <E>(
      fixerId: FixerId,
      claim: (
        fixer: FixerRow,
      ) => Effect.Effect<
        { readonly turnId: FixerTurnId; readonly body: TurnBody } | null,
        E | SqlError | SchemaError
      >,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const claimed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const fixer = yield* fixerById(fixerId);
              if (fixer === null || fixer.ended !== null) return { _tag: "ended" } as const;
              if (endsRunning.has(fixerId)) return { _tag: "ending" } as const;
              const turn = yield* claim(fixer);
              return turn === null
                ? ({ _tag: "nothing" } as const)
                : ({ _tag: "started", fixer, ...turn } as const);
            }),
          );
          if (claimed._tag !== "started") return claimed._tag;
          yield* hold("fix-turn-start");
          yield* launch(claimed.fixer, claimed.turnId, claimed.body);
          yield* publish(claimed.fixer.pr_key);
          return claimed._tag;
        }),
      );

    /**
     * Starts the oldest queued turn when nothing else holds the worktree. The check and the start
     * are one transaction, so two callers never start two turns.
     */
    const advance = (fixerId: FixerId): Effect.Effect<void> =>
      start(fixerId, () =>
        Effect.gen(function* () {
          // Every unfinished turn but a queued one holds the checkout: the busy states, and
          // one whose state prkit can't read, since its agent may still be in it.
          const busy = yield* sql`SELECT COUNT(*) AS count FROM fixer_turns
            WHERE fixer_id = ${fixerId} AND finished_at IS NULL
              AND coalesce(json_extract(status, '$._tag'), '') != 'queued'`.pipe(
            Effect.flatMap(decodeCount),
          );
          if ((busy[0]?.count ?? 0) > 0) return null;
          const [queued] = yield* turnsOf(fixerId, ["queued"]);
          if (queued === undefined) return null;
          const at = yield* now;
          yield* sql`UPDATE fixer_turns SET status = ${encodeStatus({ _tag: "preparing" })},
            run_id = ${runId}, started_at = ${at}, agent_pid = NULL, agent_started = NULL
            WHERE id = ${queued.id} AND json_extract(status, '$._tag') = 'queued'`;
          return { turnId: queued.id, body: runTurn(queued.id) };
        }),
      ).pipe(
        Effect.asVoid,
        Effect.catchTags({
          SqlError: (error) => Effect.logError("Couldn't start the next fix turn", error),
          SchemaError: (error) => Effect.logError("Couldn't read the fix queue", error),
        }),
      );

    /**
     * Ends a turn as failed: drafts go back to the owner, the checkout to the head, unless
     * something an agent turn started may still be running there.
     */
    const failTurn = (fixer: FixerRow, turnId: FixerTurnId, failure: TurnFailure) =>
      Effect.gen(function* () {
        const failed = yield* transition(turnId, ["preparing", "running"], {
          _tag: "failed",
          reason: failure.reason,
          message: failure.message,
        });
        yield* tokens.revokeTurn(turnId);
        if (!failed) return;
        yield* hold("fix-turn-end");
        yield* returnDrafts(turnId);
        const turn = yield* turnById(turnId);
        const ref = refFromKey(fixer.pr_key);
        if (ref !== null && turn?.head_sha != null)
          yield* leftovers
            .unlessLeftovers(fixer.id, repo.resetFix(ref, fixer.id, turn.head_sha))
            .pipe(Effect.ignore);
        // The message can be an agent's own words, so it stays in the activity and out of the log.
        yield* Effect.logWarning("Fix turn failed").pipe(
          Effect.annotateLogs({ turnId, reason: failure.reason }),
        );
        yield* appendActivity(fixer.pr_key, turnId, "error", failure.message);
        yield* notify(fixer, "The agent couldn't finish", failure.message);
      });

    /**
     * Whether a turn is still stored as started once its fiber is registered. A drop that came
     * between the start being stored and the registration, which `stopFiber` couldn't reach, is
     * seen here, and any later one finds the fiber. A turn prkit can't read fails instead of running.
     */
    const stillStarted = (fixer: FixerRow, turnId: FixerTurnId) =>
      turnById(turnId).pipe(
        Effect.map((turn) => turn !== null && LAUNCHED.has(turn.status._tag)),
        Effect.catchTags({
          SqlError: () =>
            failTurn(fixer, turnId, unreadable("prkit couldn't read the fix.")).pipe(
              Effect.as(false),
            ),
          SchemaError: () =>
            failTurn(fixer, turnId, unreadable("prkit read a damaged fix record.")).pipe(
              Effect.as(false),
            ),
        }),
        Effect.tapError((error) =>
          Effect.logError("Couldn't record the fix turn's failure", error),
        ),
        Effect.orElseSucceed(() => false),
      );

    /**
     * Runs a turn's body in the service's scope, in one of the app's two agent slots.
     * Interrupting the fiber stops the agent's process group.
     */
    const launch = (fixer: FixerRow, turnId: FixerTurnId, body: TurnBody) =>
      Effect.gen(function* () {
        const registered = yield* Deferred.make<void>();
        // Before any of prkit's git, what earlier turns left must have ended.
        const guarded = leftovers.settle(fixer.id).pipe(
          Effect.andThen(body),
          Effect.catchTags({
            PlatformError: () =>
              fail(
                "repository",
                "prkit couldn't write the fix's files. Check the disk has space, then retry.",
              ),
            SqlError: () => fail("agent", "prkit couldn't save the fix."),
            SchemaError: () => fail("agent", "prkit read a damaged fix record."),
            RepoError: (error) => fail(error.reason, error.message),
            LinkRefused: (error) => fail("checks", error.message),
            GitTampered: (error) => fail("checks", error.message),
            FixerError: (error) => fail("agent", error.message),
          }),
          Effect.catchTag("TurnFailure", (failure) => failTurn(fixer, turnId, failure)),
          Effect.catchTags({
            SqlError: (error) => Effect.logError("Couldn't record the fix turn's failure", error),
            SchemaError: (error) =>
              Effect.logError("Couldn't record the fix turn's failure", error),
          }),
          Effect.tapDefect((defect) =>
            Effect.logError("Fix turn crashed", defect).pipe(
              Effect.andThen(
                failTurn(
                  fixer,
                  turnId,
                  new TurnFailure({
                    reason: "agent",
                    message: "prkit hit an internal error.",
                  }),
                ),
              ),
              Effect.ignore,
            ),
          ),
          Effect.ensuring(
            fs
              .remove(turnTmpDir(path, turnId), { recursive: true, force: true })
              .pipe(
                Effect.andThen(
                  fs.remove(path.join(contextDir, turnId), { recursive: true, force: true }),
                ),
                Effect.ignore,
              ),
          ),
          Effect.andThen(publish(fixer.pr_key)),
          Effect.annotateLogs({ fixerId: fixer.id, turnId }),
        );
        const inSlot = agents.slots
          .withPermitsIfAvailable(1)(guarded)
          .pipe(
            Effect.flatMap((ran) =>
              Option.isSome(ran)
                ? Effect.void
                : appendActivity(fixer.pr_key, turnId, "phase", "queued").pipe(
                    Effect.ignore,
                    Effect.andThen(agents.slots.withPermits(1)(guarded)),
                  ),
            ),
          );
        const fiber = yield* Deferred.await(registered).pipe(
          Effect.andThen(stillStarted(fixer, turnId)),
          Effect.flatMap((started) =>
            started
              ? inSlot
              : Effect.logInfo("A fix was dropped before it started, so it didn't run"),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(turnId))),
          // The next queued turn starts once this one has let go of the worktree.
          Effect.andThen(Effect.suspend(() => advance(fixer.id))),
          Effect.forkIn(scope),
        );
        running.set(turnId, fiber);
        yield* Deferred.succeed(registered, undefined);
      });

    /**
     * Waits until the turn's earlier run, if any, has let go. A change request runs under its
     * turn's id again, so it starts only after the run that made the result is done: that run's
     * cleanup and failure handling can't then reach the new one.
     */
    const letGo = (turnId: FixerTurnId) =>
      Effect.suspend(() => {
        const previous = running.get(turnId);
        return previous === undefined ? Effect.void : Fiber.await(previous).pipe(Effect.asVoid);
      });

    /** Stops a turn's fiber, unless it is the caller's own, and waits for its process to go. */
    const stopFiber = (turnId: FixerTurnId) =>
      Effect.gen(function* () {
        const fiber = running.get(turnId);
        if (fiber !== undefined && fiber !== (yield* Effect.fiber)) yield* Fiber.interrupt(fiber);
        awaiting.delete(turnId);
        yield* tokens.revokeTurn(turnId);
      });

    /**
     * Stores a queued turn in the caller's transaction, only while its session is live, so no turn
     * ever waits in an ended session: null once it has ended. `prepare` writes anything else the
     * turn needs in the same transaction. `afterQueued` does the rest once it is committed.
     */
    const queueTurn = (
      fixer: FixerRow,
      work: WorkRequest,
      trigger: FixerTrigger,
      input: QueueInput = {},
    ) =>
      Effect.gen(function* () {
        const turnId = FixerTurnId.make(yield* newId);
        const at = yield* now;
        const startedBy = input.startedBy === undefined ? yield* StartedBy : input.startedBy;
        const inserted = yield* sql`
          INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, instance_id, model,
            started_by, created_at)
          SELECT ${turnId}, ${fixer.id}, ${work._tag}, ${encodeWork(work)}, ${trigger},
            ${encodeStatus({ _tag: "queued" })}, ${fixer.provider}, ${fixer.instance_id}, ${fixer.model},
            ${startedBy}, ${input.createdAt ?? at}
          WHERE EXISTS (SELECT 1 FROM fixers WHERE id = ${fixer.id} AND ended IS NULL)
          RETURNING id`;
        if (inserted.length === 0) return null;
        if (input.prepare !== undefined) yield* input.prepare(turnId);
        if (startedBy !== null)
          yield* recordActivity(
            turnId,
            "note",
            `Started from ${startedBy}. It waits for Push in prkit`,
          );
        return { turnId, kind: work._tag, trigger };
      });

    /** After a queued turn is committed: the log, and the queue going on. */
    const afterQueued = (
      fixer: FixerRow,
      turn: NonNullable<Effect.Success<ReturnType<typeof queueTurn>>>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Fix turn queued").pipe(
          Effect.annotateLogs({ fixerId: fixer.id, ...turn }),
        );
        yield* advance(fixer.id);
        yield* publish(fixer.pr_key);
      });

    /** Queues a turn on a PR's live session; once it is stored, the queue goes on even when the caller goes away. */
    const enqueue = (
      fixer: FixerRow,
      work: WorkRequest,
      trigger: FixerTrigger,
      input: QueueInput = {},
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const turn = yield* sql.withTransaction(queueTurn(fixer, work, trigger, input));
          if (turn === null)
            return yield* new FixerStateError({
              key: fixer.pr_key,
              message: "The agent stopped meanwhile. Try again to start it.",
            });
          yield* afterQueued(fixer, turn);
          return turn.turnId;
        }),
      );

    return { advance, start, letGo, stopFiber, queueTurn, afterQueued, enqueue, whileEnding };
  });

export type TurnQueue = Effect.Success<ReturnType<typeof makeTurnQueue>>;
