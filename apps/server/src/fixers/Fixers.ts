import {
  type AccountId,
  type AgentSelection,
  type ConflictStrategy,
  FIXER_BUSY,
  type FixComment,
  FixerError,
  type FixerFeedEntry,
  type FixerFeedEvent,
  type FixerSnapshot,
  FixerStateError,
  type FixerTrigger,
  type FixerTurnId,
  type FixerTurnState,
  FixerWorkRefused,
  type FixTarget,
  placeOn,
  type PullRequestKey,
  refFromKey,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { processHost } from "../agents/turnEnd.ts";
import { makeE2eHold } from "../e2eHold.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import { RepoCache } from "../repo/RepoCache.ts";
import { decodeRows, toComment } from "../reviewComments/pendingRow.ts";
import { reviewTarget } from "../reviews/reviewTarget.ts";
import { makeAgentRuns } from "./agentRuns.ts";
import { makeConflictTurn } from "./conflictTurn.ts";
import {
  decodeDiff,
  encodeStatus,
  type FixerRow,
  readableFixers,
  type TurnRow,
} from "./fixerRows.ts";
import { clip, decodeCount, makeFixerState } from "./fixerState.ts";
import { makeFixTools } from "./fixTools.ts";
import { makeFixWatch } from "./fixWatch.ts";
import { makePushes } from "./pushes.ts";
import { makeScriptAccess } from "./scriptAccess.ts";
import { makeSessions } from "./sessions.ts";
import { startedByFor } from "./turnRules.ts";
import { makeTurnBodies } from "./turnBodies.ts";
import { makeTurnLeftovers } from "./turnLeftovers.ts";
import { makeTurnQueue, type TurnBody } from "./turnQueue.ts";
import { makeTurnSteps } from "./turnSteps.ts";

const decodeCommits = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ commit_sha: Schema.NullOr(Schema.String) })),
);

const WORKING: ReadonlyArray<FixerTurnState> = ["queued", "preparing", "running", "pushing"];
const decodeOpenStates = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      state: Schema.Literals(["queued", "preparing", "running", "pushing", "ready"]),
    }),
  ),
);

export class Fixers extends Context.Service<Fixers, Effect.Success<typeof make>>()(
  "@prkit/server/fixers/Fixers",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* RepoCache;
  const api = yield* GitHubApi;
  const pullRequests = yield* PullRequests;
  const withRetry = makeKeyedGate<PullRequestKey>(1);
  const hold = yield* makeE2eHold;

  const state = yield* makeFixerState;
  const {
    changes,
    commandTurn,
    dbFailures,
    findFixer,
    notices,
    now,
    recordActivity,
    runId,
    snapshotOf,
    turnsOf,
    watched,
  } = state;
  const leftovers = yield* makeTurnLeftovers(yield* processHost);
  // A queued turn starts with what its kind of turn does, defined further down.
  const queue = yield* makeTurnQueue(state, leftovers, (turnId): TurnBody =>
    bodies.runTurn(turnId),
  );
  const { advance, enqueue, letGo, start } = queue;
  const sessions = yield* makeSessions(state, queue, leftovers);
  const { boundFixer, chooseAgent, chooseAgentOrKeep, dropTurn, ensureFixer, reconcile, stop } =
    sessions;
  const runs = yield* makeAgentRuns(state, leftovers);
  const pushes = yield* makePushes(state, queue, sessions);
  const { pushAccess, pushTurn } = pushes;
  const steps = yield* makeTurnSteps(state, pushes);
  const access = yield* makeScriptAccess(state);
  const conflicts = yield* makeConflictTurn(state, queue, runs, steps, sessions, access);
  const bodies = yield* makeTurnBodies(
    state,
    queue,
    runs,
    steps,
    conflicts,
    sessions,
    access,
    leftovers,
  );
  const { reviseBody } = bodies;
  const { finishFixes, finishConflicts, reportProgress } = yield* makeFixTools(state, conflicts);

  const get = (key: PullRequestKey) =>
    hold("fix-session-read").pipe(Effect.andThen(snapshotOf(key)), Effect.catchTags(dbFailures));
  const history = (key: PullRequestKey) => snapshotOf(key, true).pipe(Effect.catchTags(dbFailures));
  const turnActivity = (key: PullRequestKey, turnId: FixerTurnId) =>
    state.turnActivity(key, turnId).pipe(Effect.catchTags(dbFailures));

  /** The comments as the agent gets them, read fresh: drafts from prkit, threads from GitHub. */
  const commentsFor = (
    key: PullRequestKey,
    accountId: AccountId,
    targets: ReadonlyArray<FixTarget>,
  ) =>
    Effect.gen(function* () {
      const draftIds = targets.flatMap((target) => (target._tag === "draft" ? [target.id] : []));
      const rows =
        draftIds.length === 0
          ? []
          : yield* sql`SELECT * FROM pending_comments WHERE pr_key = ${key} AND account_id = ${accountId} AND id IN ${sql.in(draftIds)}`.pipe(
              Effect.flatMap(decodeRows),
            );
      const drafts =
        rows.length === 0
          ? []
          : yield* pullRequests.files(key, accountId).pipe(
              Effect.map((files) =>
                rows.map((row) => ({ row, placed: placeOn(toComment(row), files) })),
              ),
              Effect.catchTag("PullRequestReadError", (error) =>
                Effect.fail(new FixerError({ message: error.message })),
              ),
            );
      const threads = targets.some((target) => target._tag === "thread")
        ? (yield* pullRequests
            .threads(key, accountId)
            .pipe(
              Effect.catchTag("PullRequestReadError", (error) =>
                Effect.fail(new FixerError({ message: error.message })),
              ),
            )).threads
        : [];
      const comments: Array<FixComment> = [];
      for (const target of targets) {
        const id = `c${comments.length + 1}`;
        if (target._tag === "draft") {
          const draft = drafts.find(({ row }) => row.id === target.id);
          if (
            draft === undefined ||
            draft.row.state !== "draft" ||
            draft.row.submission_id !== null
          )
            return yield* new FixerError({
              message:
                "A comment you picked was sent or changed meanwhile. Refresh and pick again.",
            });
          const { row, placed } = draft;
          const at = placed._tag === "outdated" ? null : placed.placement.anchor;
          comments.push({
            id,
            source: { _tag: "draft", draftId: target.id },
            path: row.path,
            lines: at && { side: at.end.side, start: at.start.line, end: at.end.line },
            snippet: row.snippet,
            body: row.body,
          });
          continue;
        }
        const thread = threads.find((row) => row.id === target.threadId);
        if (thread === undefined)
          return yield* new FixerError({
            message:
              "A thread you picked is no longer on the pull request. Refresh and pick again.",
          });
        comments.push({
          id,
          source: {
            _tag: "thread",
            threadId: thread.id,
            url: thread.comments[0]?.url ?? null,
            canReply: thread.canReply,
          },
          path: thread.path,
          lines:
            thread.anchor === null
              ? null
              : {
                  side: thread.anchor.end.side,
                  start: thread.anchor.start.line,
                  end: thread.anchor.end.line,
                },
          snippet: thread.diffHunk.split("\n").slice(-8).join("\n"),
          body: thread.comments
            .map((comment) => `${comment.author?.login ?? "ghost"}: ${comment.body}`)
            .join("\n\n"),
        });
      }
      const [first, ...rest] = comments;
      if (first === undefined)
        return yield* new FixerError({ message: "Pick at least one comment." });
      return [first, ...rest] as const;
    });

  /** Marks the batch's drafts as with the agent; a draft that moved on fails the whole send. */
  const holdDrafts = (comments: ReadonlyArray<FixComment>) => (turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const at = yield* now;
      for (const comment of comments) {
        if (comment.source._tag !== "draft") continue;
        const rows =
          yield* sql`UPDATE pending_comments SET state = 'sent-to-agent', fixer_turn_id = ${turnId}, updated_at = ${at}
          WHERE id = ${comment.source.draftId} AND state = 'draft' AND submission_id IS NULL RETURNING id`;
        if (rows.length === 0)
          return yield* new FixerError({
            message: "A comment you picked was sent or changed meanwhile. Refresh and pick again.",
          });
      }
    });

  const send = (
    key: PullRequestKey,
    accountId: AccountId,
    input: {
      readonly agent?: AgentSelection;
      readonly targets: ReadonlyArray<FixTarget>;
      readonly note: string | null;
      readonly replyAfterPush: boolean;
    },
    trigger: FixerTrigger = "user",
  ) =>
    Effect.gen(function* () {
      const existing = yield* boundFixer(key, accountId);
      const agent = yield* chooseAgent(input.agent, existing);
      const comments = yield* commentsFor(key, accountId, input.targets);
      const fixer = yield* ensureFixer(key, accountId, agent);
      const note = input.note?.trim() ?? "";
      yield* enqueue(
        fixer,
        {
          _tag: "fix",
          comments,
          note: note === "" ? null : note.slice(0, 2000),
          replyAfterPush: input.replyAfterPush,
        },
        trigger,
        { prepare: holdDrafts(comments) },
      );
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  const resolveConflicts = (
    key: PullRequestKey,
    accountId: AccountId,
    input: { readonly agent?: AgentSelection; readonly strategy: ConflictStrategy },
    trigger: FixerTrigger = "user",
  ) =>
    Effect.gen(function* () {
      const existing = yield* boundFixer(key, accountId);
      if (existing !== null && existing.ended === null) {
        const open = yield* turnsOf(existing.id, [...FIXER_BUSY, "queued"]);
        if (open.some((turn) => turn.work._tag === "conflicts"))
          return yield* new FixerStateError({
            key,
            message: "prkit is already resolving this pull request's conflicts.",
          });
      }
      if (input.strategy === "rebase") {
        const ref = refFromKey(key);
        const target =
          ref === null
            ? null
            : yield* reviewTarget(ref, accountId).pipe(
                Effect.provideService(GitHubApi, api),
                Effect.catchTag("GitHubRequestError", (error) =>
                  Effect.fail(new FixerError({ message: error.message })),
                ),
              );
        if (target === null || target.author !== accountId.slice(accountId.indexOf("/") + 1))
          return yield* new FixerStateError({
            key,
            message:
              "Rebasing rewrites the branch's history, so prkit offers it only on your own pull requests. Merge the base instead.",
          });
      }
      const agent = yield* chooseAgent(input.agent, existing);
      const fixer = yield* ensureFixer(key, accountId, agent);
      yield* enqueue(fixer, { _tag: "conflicts", strategy: input.strategy }, trigger);
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  const discard = (key: PullRequestKey, turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const { row, fixer, outcome } = yield* commandTurn(key, turnId, "discard");
      if (outcome._tag === "reject")
        return yield* new FixerStateError({ key, message: outcome.message });
      if (outcome._tag === "start")
        yield* dropTurn(fixer, row, {
          _tag: "discarded",
          reason: "user",
          message:
            row.status._tag === "ready"
              ? "Discarded. Nothing reached GitHub"
              : "Stopped and discarded",
        });
      yield* advance(fixer.id);
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * Stop for an outside agent: drops the turns still queued or working on fresh work, and
   * nothing else. The session stays, and so does every commit waiting for Push, including
   * one the agent is changing (docs/features/outside-agents.md).
   */
  const stopWorking = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const fixer = yield* findFixer(key);
      if (fixer === null || fixer.ended !== null)
        return yield* new FixerStateError({ key, message: "No agent works on this pull request." });
      const caller = yield* StartedBy;
      const fresh: ReadonlyArray<FixerTurnState> = ["queued", "preparing", "running"];
      let changesLeft = 0;
      for (const row of yield* turnsOf(fixer.id, fresh)) {
        // `rounds = 0` is checked again in the drop's own UPDATE.
        const dropped = yield* dropTurn(
          fixer,
          row,
          {
            _tag: "discarded",
            reason: "user",
            message: caller === null ? "Stopped" : `Stopped from ${caller}`,
          },
          fresh,
          true,
        );
        if (!dropped && row.rounds > 0) changesLeft += 1;
      }
      yield* advance(fixer.id);
      return { snapshot: yield* snapshotOf(key), changesLeft };
    }).pipe(Effect.catchTags(dbFailures));

  const revise = (key: PullRequestKey, turnId: FixerTurnId, note: string) =>
    Effect.gen(function* () {
      const { row, fixer, outcome } = yield* commandTurn(key, turnId, "revise");
      if (outcome._tag === "reject")
        return yield* new FixerStateError({ key, message: outcome.message });
      if (row.work._tag === "revert")
        return yield* new FixerStateError({
          key,
          message: "A revert has nothing for the agent to change.",
        });
      const cleaned = note.trim().slice(0, 2000);
      if (cleaned === "")
        return yield* new FixerError({ message: "Say what the agent should change." });
      // A change an outside agent asks for makes the turn its work too, so it waits for Push.
      const caller = yield* StartedBy;
      const startedBy = startedByFor(row.started_by, caller);
      yield* letGo(turnId);
      const started = yield* start(fixer.id, () =>
        Effect.gen(function* () {
          const at = yield* now;
          const moved =
            yield* sql`UPDATE fixer_turns SET status = ${encodeStatus({ _tag: "running" })},
              rounds = rounds + 1, run_id = ${runId}, started_at = ${at}, finished_at = NULL,
              started_by = ${startedBy}
              WHERE id = ${turnId} AND json_extract(status, '$._tag') = 'ready' RETURNING id`;
          if (moved.length === 0) return null;
          yield* recordActivity(
            turnId,
            "note",
            `${caller === null ? "You" : caller} asked: ${clip(cleaned, 300)}`,
          );
          return { turnId, body: reviseBody(turnId, cleaned) };
        }),
      );
      if (started === "ended")
        return yield* new FixerStateError({
          key,
          message:
            "The agent is stopped. Push or discard these changes, or send the comments again.",
        });
      if (started === "ending")
        return yield* new FixerStateError({
          key,
          message: "prkit is still stopping the agent. Ask again in a moment.",
        });
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  const retry = (
    key: PullRequestKey,
    turnId: FixerTurnId,
    input: { readonly refuse?: ReadonlyArray<"revert"> } = {},
  ) =>
    withRetry(
      key,
      Effect.gen(function* () {
        const { row, fixer, outcome } = yield* commandTurn(key, turnId, "retry");
        // Work is immutable. Read its stored kind under the same gate that queues the retry.
        if (row.work._tag === "revert" && input.refuse?.includes("revert"))
          return yield* new FixerWorkRefused({
            key,
            message: "Reverts run again only from prkit, by the owner.",
          });
        if (outcome._tag === "reject")
          return yield* new FixerStateError({ key, message: outcome.message });
        if (outcome._tag === "noop") return yield* snapshotOf(key);
        const startedBy = startedByFor(row.started_by, yield* StartedBy);
        return yield* retryWork(key, row, fixer).pipe(Effect.provideService(StartedBy, startedBy));
      }),
    ).pipe(Effect.catchTags(dbFailures));

  /** Runs a turn's work again, as a new turn. */
  const retryWork = (key: PullRequestKey, row: TurnRow, fixer: FixerRow) =>
    Effect.gen(function* () {
      switch (row.work._tag) {
        case "fix":
          return yield* send(
            key,
            fixer.account_id,
            {
              targets: row.work.comments.map((comment): FixTarget =>
                comment.source._tag === "draft"
                  ? { _tag: "draft", id: comment.source.draftId }
                  : { _tag: "thread", threadId: comment.source.threadId },
              ),
              note: row.work.note,
              replyAfterPush: row.work.replyAfterPush,
            },
            "retry",
          );
        case "conflicts":
          return yield* resolveConflicts(
            key,
            fixer.account_id,
            { strategy: row.work.strategy },
            "retry",
          );
        case "revert": {
          // A revert runs no agent: no agent being ready never blocks it.
          const bound = yield* ensureFixer(key, fixer.account_id, yield* chooseAgentOrKeep(fixer));
          yield* enqueue(bound, row.work, "retry");
          return yield* snapshotOf(key);
        }
      }
    }).pipe(Effect.catchTags(dbFailures));

  const revert = (key: PullRequestKey, turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const { row, fixer, outcome } = yield* commandTurn(key, turnId, "revert");
      if (outcome._tag === "reject")
        return yield* new FixerStateError({ key, message: outcome.message });
      if (row.commit_sha === null)
        return yield* new FixerError({ message: "There is no merge to revert." });
      const bound = yield* ensureFixer(key, fixer.account_id, yield* chooseAgentOrKeep(fixer));
      yield* enqueue(bound, { _tag: "revert", turnId, sha: row.commit_sha }, "user");
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  /** A turn's diff for the Fixes panel; immutable once the commit exists. */
  const diff = (key: PullRequestKey, turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const { row } = yield* commandTurn(key, turnId, "push");
      const rows = yield* sql`SELECT diff FROM fixer_turns WHERE id = ${row.id}`.pipe(
        Effect.flatMap(decodeDiff),
      );
      const stored = rows[0]?.diff ?? null;
      if (stored === null)
        return yield* new FixerError({ message: "This fix has no changes to show yet." });
      return stored;
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * The new side of paths at a turn's commit, from prkit's own copy, where the commit stays until
   * Push. The caller names the commit it shows, and a turn that has moved on refuses.
   */
  const texts = (
    key: PullRequestKey,
    turnId: FixerTurnId,
    sha: string,
    paths: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT t.commit_sha FROM fixer_turns t
        JOIN fixers f ON f.id = t.fixer_id WHERE t.id = ${turnId} AND f.pr_key = ${key}`.pipe(
        Effect.flatMap(decodeCommits),
      );
      const ref = refFromKey(key);
      if (rows[0] === undefined || ref === null)
        return yield* new FixerError({ message: "This fix is no longer there. Refresh." });
      if (rows[0].commit_sha !== sha)
        return yield* new FixerError({
          message: "This fix changed. Open it again to read its code.",
        });
      return yield* repo.readTexts(ref, sha, paths);
    }).pipe(
      Effect.catchTags({
        ...dbFailures,
        RepoError: (error) => Effect.fail(new FixerError({ message: error.message })),
      }),
    );

  /** The changes as a patch, for an account that can't push to the branch. */
  const patch = (key: PullRequestKey, turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const { row, fixer } = yield* commandTurn(key, turnId, "push");
      if (row.commit_sha === null || row.head_sha === null)
        return yield* new FixerError({ message: "This fix has no commit yet." });
      const ref = refFromKey(fixer.pr_key);
      if (ref === null)
        return yield* new FixerError({ message: "This pull request's key can't be read." });
      const merge = row.work._tag === "conflicts" && row.work.strategy === "merge";
      const rebase = row.work._tag === "conflicts" && row.work.strategy === "rebase";
      const text = yield* repo
        .patchOf(repo.checkout(ref, repo.fixerPath(fixer.id)), {
          sha: row.commit_sha,
          from: rebase ? (row.base_sha ?? row.head_sha) : row.head_sha,
          merge,
        })
        .pipe(
          Effect.catchTag("RepoError", () =>
            Effect.fail(
              new FixerError({
                message: "prkit's copy of this fix is gone, so there is no patch to copy.",
              }),
            ),
          ),
        );
      return { patch: text };
    }).pipe(Effect.catchTags(dbFailures));

  const watch = (key: PullRequestKey): Stream.Stream<FixerSnapshot, FixerError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const subscription = yield* PubSub.subscribe(changes);
        yield* hold("fix-session-read");
        const first = yield* snapshotOf(key);
        return Stream.concat(
          Stream.succeed(first),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === key),
            Stream.mapEffect(() => snapshotOf(key).pipe(Effect.catchTags(dbFailures))),
          ),
        );
      }).pipe(Effect.catchTags(dbFailures)),
    );

  const feedEntry = (fixer: FixerRow) =>
    Effect.gen(function* () {
      // Only the states count, so a turn with damaged work or results can't hide the others.
      const open =
        fixer.ended === null
          ? yield* sql`SELECT json_extract(status, '$._tag') AS state FROM fixer_turns
              WHERE fixer_id = ${fixer.id} AND json_extract(status, '$._tag') IN ${sql.in([...WORKING, "ready"])}`.pipe(
              Effect.flatMap(decodeOpenStates),
            )
          : [];
      const [all] =
        yield* sql`SELECT COUNT(*) AS count FROM fixer_turns WHERE fixer_id = ${fixer.id}`.pipe(
          Effect.flatMap(decodeCount),
        );
      return {
        key: fixer.pr_key,
        accountId: fixer.account_id,
        state: open.some((turn) => WORKING.includes(turn.state))
          ? "working"
          : open.length > 0
            ? "waiting"
            : "idle",
        turns: all?.count ?? 0,
      } satisfies FixerFeedEntry;
    });

  /** Every PR's fixer for tabs and notifications: the index, each change, and notices. */
  const feed = (): Stream.Stream<FixerFeedEvent, FixerError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changed = yield* PubSub.subscribe(changes);
        const noticed = yield* PubSub.subscribe(notices);
        const all = yield* sql`SELECT * FROM fixers`.pipe(Effect.flatMap(readableFixers));
        const entries = yield* Effect.forEach(all, feedEntry);
        const sent = new Map(entries.map((entry) => [entry.key, entry]));
        const updates = Stream.fromSubscription(changed).pipe(
          Stream.mapEffect((key) =>
            findFixer(key).pipe(
              Effect.flatMap((fixer) => (fixer === null ? Effect.succeed(null) : feedEntry(fixer))),
              Effect.catchTags(dbFailures),
            ),
          ),
          Stream.flatMap((entry): Stream.Stream<FixerFeedEvent> => {
            const last = entry === null ? undefined : sent.get(entry.key);
            if (entry === null || (last?.state === entry.state && last.turns === entry.turns))
              return Stream.empty;
            sent.set(entry.key, entry);
            return Stream.succeed({ _tag: "changed", fixer: entry });
          }),
        );
        return Stream.concat(
          Stream.succeed<FixerFeedEvent>({ _tag: "index", fixers: entries }),
          Stream.merge(updates, Stream.fromSubscription(noticed)),
        );
      }).pipe(Effect.catchTags(dbFailures)),
    );

  const { observed } = yield* makeFixWatch(state, queue, sessions, resolveConflicts);

  yield* reconcile;

  return {
    get,
    history,
    turnActivity,
    watch,
    feed,
    send,
    resolveConflicts,
    push: (key: PullRequestKey, turnId: FixerTurnId) => pushTurn(key, turnId),
    discard,
    stopWorking,
    revise,
    retry,
    revert,
    stop,
    diff,
    patch,
    texts,
    pushAccess,
    scriptAccess: access.forPullRequest,
    finishFixes,
    finishConflicts,
    reportProgress,
    watched,
    observed,
  };
});

export const layer = Layer.effect(Fixers, make);
