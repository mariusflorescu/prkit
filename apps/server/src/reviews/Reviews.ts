import {
  type AccountId,
  type AgentSelection,
  effectiveSelection,
  findAgentEntry,
  type GuidanceEdit,
  isLocalReviewKey,
  PullRequestKey,
  pullRequestKey,
  type Review,
  type ReviewCore,
  ReviewError,
  ReviewStateError,
  ReviewStatus,
  type ReviewWatchEvent,
  refFromKey,
  selectionProblem,
  type StackGuidesResult,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { decodeReadable } from "../persistence/damagedRows.ts";
import { unattended } from "./ContextPriority.ts";
import { decide, type Observation, observe } from "./lifecycle.ts";
import { makeLocalReviews } from "./localReviews.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import {
  encodeStatus,
  makeReviewStore,
  type PullRequestReview,
  PullRequestRow,
  toPullRequestReview,
} from "./reviewStore.ts";
import { makeAttemptStart, storedAgentOf } from "./attemptStart.ts";
import { decodeCount, makeAttemptRun } from "./attemptRun.ts";
import { makeGuideTools } from "./guideTools.ts";
import { makeReviewReads } from "./reviewReads.ts";
import { makeAttemptPlans } from "./attemptPlans.ts";
import { makeAttemptTurn } from "./attemptTurn.ts";
import { makeReconcile } from "./reconcile.ts";

export {
  AttemptRow,
  type Change,
  type LocalStoredReview,
  type NewSubject,
  type ReadyNotice,
  ReviewRow,
  type StoredAgent,
  type StoredReview,
} from "./reviewStore.ts";
export {
  SubmitGuideReceipt,
  SubmitGuideRejected,
  ToolReceipt,
  ToolRejected,
} from "./guideTools.ts";
export { type RevisionContext } from "./reviewReads.ts";
export { type Origin } from "./attemptStart.ts";

const readablePullRequests = decodeReadable("reviews", PullRequestRow);

/** What the watcher reads and applies its reads to: pull requests only. */
export type WatchedReview = PullRequestReview;

export class Reviews extends Context.Service<Reviews, Effect.Success<typeof make>>()(
  "@prkit/server/reviews/Reviews",
) {}

export const make = Effect.gen(function* () {
  const store = yield* makeReviewStore;
  const {
    sql,
    repo,
    agents,
    guideSettings,
    guideConfig,
    pullRequests,
    changes,
    notices,
    now,
    newId,
    publish,
    findReview,
    findLocal,
    locals,
    summaryOf,
    progressOf,
    snapshotOf,
    activityOf,
    captureOf,
    dbFailures,
  } = store;
  const tools = makeGuideTools(store);
  const { reportProgress, noteFile, submitDraft, submitGuide, reviseGuide } = tools;
  const { guide, revisionContext, draft, diff, texts, typicalDuration, index, feed } =
    makeReviewReads(store);
  const plans = makeAttemptPlans(store);
  const turn = makeAttemptTurn(store, tools);
  const run = makeAttemptRun(store, plans, turn);
  const { end } = run;
  const start = makeAttemptStart(store, run);
  const { startAttempt, ensureReview } = start;
  const { reconcile } = makeReconcile(store, start);

  const get = (key: PullRequestKey) => snapshotOf(key).pipe(Effect.catchTags(dbFailures));

  /**
   * The agent for a new attempt: the one asked for (checked against the catalog),
   * else the review's own, else the default from Settings > Guides.
   */
  const chooseAgent = (requested: AgentSelection | undefined, review: ReviewCore | null) =>
    Effect.gen(function* () {
      if (requested === undefined && review !== null) return storedAgentOf(review);
      const catalog = yield* agents.catalog();
      if (requested !== undefined) {
        const problem = selectionProblem(catalog, requested);
        const entry = findAgentEntry(catalog, requested.instance);
        if (problem !== null || entry === undefined)
          return yield* new ReviewError({ message: problem ?? "Pick an agent." });
        return { ...requested, provider: entry.kind };
      }
      const settings = yield* guideSettings
        .get()
        .pipe(
          Effect.catchTag("GuideSettingsError", (error) =>
            Effect.fail(new ReviewError({ message: error.message })),
          ),
        );
      const chosen = effectiveSelection(catalog, settings.defaultAgent);
      const entry = chosen === null ? undefined : findAgentEntry(catalog, chosen.instance);
      if (chosen === null || entry === undefined)
        return yield* new ReviewError({
          message:
            (chosen === null ? null : selectionProblem(catalog, chosen)) ??
            "No agent is ready to write guides. Sign one in under Settings > Agents, then check again.",
        });
      return { ...chosen, provider: entry.kind };
    });

  /**
   * Starts a guide. `guidance` is the PR's guidance block as typed in the composer;
   * it is saved first, version-checked, so the attempt freezes it with the rest.
   */
  const generate = (
    key: PullRequestKey,
    accountId: AccountId,
    input: { readonly agent?: AgentSelection; readonly guidance?: GuidanceEdit },
  ) =>
    Effect.gen(function* () {
      if (refFromKey(key) === null)
        return yield* new ReviewError({ message: "That doesn't look like a pull request." });
      const existing = yield* findReview(key);
      const agent = yield* chooseAgent(input.agent, existing);
      if (input.guidance !== undefined)
        yield* guideConfig.save({
          scope: { _tag: "pull-request", key },
          expectedVersion: input.guidance.expectedVersion,
          edit: { _tag: "guidance", text: input.guidance.text, mode: input.guidance.mode },
        });
      const { review, created } = yield* ensureReview(
        { kind: "pull-request", key, accountId },
        agent,
        (yield* StartedBy) === null ? "user" : "outside",
      );
      if (!created) {
        const outcome = decide("generate", review.status);
        if (outcome._tag === "start")
          yield* startAttempt(review, review.latestRevision === null ? "first" : "retry", {
            agent,
          });
      }
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * Guides for the chosen layers of the stack `key` is in, bottom to top, with one
   * agent, announced together (docs/internals/architecture.md "Stacks"). Guidance
   * typed in the composer goes to every chosen layer. A new review is bound to the
   * account that read the stack, an existing one keeps its own. A layer that already
   * has a guide is skipped unless `regenerate`; a running or closed one always is.
   */
  const generateStack = (
    key: PullRequestKey,
    accountId: AccountId,
    input: {
      readonly layers: ReadonlyArray<number>;
      readonly regenerate: boolean;
      readonly agent?: AgentSelection;
      readonly guidance?: GuidanceEdit;
    },
  ) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      if (ref === null)
        return yield* new ReviewError({ message: "That doesn't look like a pull request." });
      const stack = yield* pullRequests
        .stack(key, accountId)
        .pipe(
          Effect.catchTag("PullRequestReadError", (error) =>
            Effect.fail(new ReviewError({ message: error.message })),
          ),
        );
      const chosen = stack?.layers.filter((layer) => input.layers.includes(layer.number)) ?? [];
      if (stack === null || chosen.length !== new Set(input.layers).size)
        return yield* new ReviewError({
          message: "The stack changed since you chose its layers. Refresh and choose them again.",
        });
      const agent = yield* chooseAgent(input.agent, yield* findReview(key));
      const own = { _tag: "pull-request" as const, key };
      const shared =
        input.guidance === undefined
          ? (yield* guideConfig.scope(own)).guidance
          : (yield* guideConfig.save({
              scope: own,
              expectedVersion: input.guidance.expectedVersion,
              edit: { _tag: "guidance", text: input.guidance.text, mode: input.guidance.mode },
            })).guidance;
      const plan: Array<{
        readonly key: PullRequestKey;
        readonly review: PullRequestReview | null;
      }> = [];
      const skipped: Array<StackGuidesResult["skipped"][number]> = [];
      for (const layer of chosen) {
        const layerKey = pullRequestKey({ ...ref, number: layer.number });
        const review = yield* findReview(layerKey);
        if (layer.state !== "open") skipped.push({ key: layerKey, reason: "not-open" });
        else if (review?.status._tag === "preparing" || review?.status._tag === "writing")
          skipped.push({ key: layerKey, reason: "running" });
        else if (review !== null && review.latestRevision !== null && !input.regenerate)
          skipped.push({ key: layerKey, reason: "has-guide" });
        else plan.push({ key: layerKey, review });
      }
      if (shared.text !== "")
        for (const item of plan) {
          if (item.key === key) continue;
          const scope = { _tag: "pull-request" as const, key: item.key };
          const current = (yield* guideConfig.scope(scope)).guidance;
          if (current.text === shared.text && current.mode === shared.mode) continue;
          yield* guideConfig.save({
            scope,
            expectedVersion: current.version,
            edit: { _tag: "guidance", text: shared.text, mode: shared.mode },
          });
        }
      const started: Array<PullRequestKey> = [];
      if (plan.length > 0) {
        const batch = yield* newId;
        yield* sql`
          INSERT INTO guide_batches (id, origin_key, account_id, created_at)
          VALUES (${batch}, ${key}, ${accountId}, ${yield* now})`;
        for (const item of plan) {
          // With no agent picked, a layer on a setting prkit can't read stays on it and fails
          // saying so, rather than moving to this PR's agent and maybe another login.
          const stays =
            input.agent === undefined &&
            item.review !== null &&
            (yield* agents
              .usable(item.review.instance, item.review.provider)
              .pipe(
                Effect.flatMap((instance) =>
                  instance === null ? Effect.succeed(null) : agents.damagedMessage(instance),
                ),
              )) !== null;
          const ran =
            item.review === null
              ? (yield* ensureReview(
                  { kind: "pull-request", key: item.key, accountId },
                  agent,
                  "user",
                  batch,
                )).created
              : yield* startAttempt(
                  item.review,
                  item.review.latestRevision === null ? "first" : "retry",
                  stays ? { batch } : { agent, batch },
                );
          if (ran) started.push(item.key);
        }
        yield* Effect.logInfo("Stack guides started").pipe(
          Effect.annotateLogs({ batch, stack: stack.number, started: started.length }),
        );
      }
      return { started, skipped } satisfies StackGuidesResult;
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * Auto mode: a guide for a review request, with the default agent, only if the PR
   * has no review yet. Never starts a second attempt on an existing review.
   */
  const autoGenerate = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      if ((yield* findReview(key)) !== null) return false;
      const agent = yield* chooseAgent(undefined, null);
      const { created } = yield* unattended(
        ensureReview({ kind: "pull-request", key, accountId }, agent, "auto"),
      );
      return created;
    }).pipe(Effect.catchTags(dbFailures));

  /** Auto-started reviews still preparing or writing; auto mode runs one at a time. */
  const autoRunning = sql`
    SELECT COUNT(*) AS count FROM reviews
    WHERE origin = 'auto' AND json_extract(status, '$._tag') IN ('preparing', 'writing')`.pipe(
    Effect.flatMap(decodeCount),
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

  const retry = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const review = yield* findReview(key);
      const outcome = decide("retry", review?.status ?? null);
      if (outcome._tag === "reject")
        return yield* new ReviewStateError({ key, message: outcome.message });
      if (outcome._tag === "start" && review !== null) yield* startAttempt(review, "retry");
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  /** A pull request's Stop; a local review's key is a string too, and stops only through `local`. */
  const stop = (key: PullRequestKey) =>
    (isLocalReviewKey(key) ? Effect.void : end(key, "stopped")).pipe(
      Effect.andThen(snapshotOf(key)),
      Effect.catchTags(dbFailures),
    );

  /** Every review the watcher reads: all pull requests' that are not done. */
  const watched = sql`
    SELECT * FROM reviews WHERE json_extract(status, '$._tag') != 'done' AND local IS NULL`.pipe(
    Effect.flatMap(readablePullRequests),
    Effect.map((rows): ReadonlyArray<WatchedReview> => rows.map(toPullRequestReview)),
  );

  /** Records a watch problem once per distinct message; the next good read clears it. */
  const noteProblem = (review: Review, message: string | null) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE reviews SET watch_problem = ${message}, updated_at = ${at}
        WHERE id = ${review.id} AND json_extract(status, '$._tag') != 'done'
          AND watch_problem IS NOT ${message} RETURNING id`;
      if (rows.length === 0) return;
      yield* message === null
        ? Effect.logInfo("Watcher read the pull request again")
        : Effect.logWarning("Watcher couldn't read the pull request").pipe(
            Effect.annotateLogs({ problem: message }),
          );
      yield* publish(review.key);
    }).pipe(Effect.annotateLogs({ reviewId: review.id, key: review.key }));

  /**
   * Applies one watcher read to a review it saw in `status` (docs/internals/architecture.md
   * "The watcher"). Every write compares and sets, so a review that moved on since the
   * read is left alone.
   */
  const observed = (review: WatchedReview, observation: Observation) =>
    Effect.gen(function* () {
      const action = observe(review.status, observation);
      switch (action._tag) {
        case "none":
          return;
        case "end":
          yield* Effect.logInfo("Pull request ended; ending its review").pipe(
            Effect.annotateLogs({ reviewId: review.id, reason: action.reason }),
          );
          return yield* end(review.key, action.reason);
        case "update": {
          yield* noteProblem(review, null);
          const started = yield* unattended(
            startAttempt(review, "new-commits", { from: ["watching"] }),
          );
          if (started)
            yield* Effect.logInfo("New head; updating the guide").pipe(
              Effect.annotateLogs({ reviewId: review.id, headSha: action.headSha }),
            );
          return;
        }
        case "checked": {
          if (review.status._tag === "watching") {
            const at = yield* now;
            const rows = yield* sql`
              UPDATE reviews SET status = json_set(status, '$.checkedAt', ${at}), watch_problem = NULL,
                updated_at = ${at}
              WHERE id = ${review.id} AND current_attempt_id IS NULL
                AND json_extract(status, '$._tag') = 'watching'
                AND json_extract(status, '$.headSha') = ${review.status.headSha} RETURNING id`;
            if (rows.length > 0) yield* publish(review.key);
            return;
          }
          return yield* noteProblem(review, null);
        }
        case "problem":
          return yield* noteProblem(review, action.message);
        case "fail-account": {
          const at = yield* now;
          const status = {
            _tag: "failed",
            reason: "account",
            message: action.message,
            attemptId: null,
          } satisfies ReviewStatus;
          const rows = yield* sql`
            UPDATE reviews SET status = ${encodeStatus(status)}, updated_at = ${at}
            WHERE id = ${review.id} AND current_attempt_id IS NULL
              AND json_extract(status, '$._tag') = 'watching' RETURNING id`;
          if (rows.length === 0) return;
          yield* Effect.logWarning("GitHub refused the review's account").pipe(
            Effect.annotateLogs({ reviewId: review.id, accountId: review.accountId }),
          );
          yield* publish(review.key);
          return;
        }
      }
    });

  const watch = (key: PullRequestKey): Stream.Stream<ReviewWatchEvent, ReviewError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const subscription = yield* PubSub.subscribe(changes);
        const first = yield* snapshotOf(key);
        let lastId = first.activity.reduce((max, line) => Math.max(max, line.id), 0);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((change) => change.key === key),
          Stream.mapEffect((change) =>
            Effect.gen(function* () {
              const summary = yield* summaryOf(key);
              const activity = change.activity.filter((line) => line.id > lastId);
              lastId = activity.reduce((max, line) => Math.max(max, line.id), lastId);
              const events: ReadonlyArray<ReviewWatchEvent> =
                summary.review === null
                  ? []
                  : [
                      {
                        _tag: "update",
                        review: summary.review,
                        attempt: summary.attempt,
                        revisions: summary.revisions,
                        activity,
                      },
                    ];
              return events;
            }).pipe(Effect.catchTags(dbFailures)),
          ),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        );
        const opening: ReviewWatchEvent = { _tag: "snapshot", snapshot: first };
        return Stream.concat(Stream.succeed(opening), updates);
      }).pipe(Effect.catchTags(dbFailures)),
    );

  yield* reconcile;

  const local = yield* makeLocalReviews(
    {
      findLocal,
      locals,
      progressOf,
      activityOf,
      captureOf,
      chooseAgent,
      ensureReview,
      startAttempt,
      end,
      publish,
      changes,
      notices,
    },
    repo.local,
  );

  return {
    get,
    generate,
    generateStack,
    autoGenerate,
    autoRunning,
    retry,
    stop,
    watch,
    index,
    feed,
    guide,
    revisionContext,
    draft,
    diff,
    texts,
    typicalDuration,
    submitGuide,
    reviseGuide,
    submitDraft,
    noteFile,
    reportProgress,
    watched,
    observed,
    local,
  };
});

export const layer = Layer.effect(Reviews, make);
