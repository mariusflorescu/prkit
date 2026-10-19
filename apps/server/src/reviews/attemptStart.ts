import {
  AttemptId,
  AttemptTrigger,
  effectiveSelection,
  findAgentEntry,
  LocalSource,
  type ReviewCore,
  ReviewError,
  ReviewId,
  ReviewStatus,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LocalCapture } from "../repo/localCapture.ts";
import { STARTABLE } from "./lifecycle.ts";
import {
  encodeOptions,
  encodeStatus,
  type NewSubject,
  type ReviewStore,
  type StoredAgent,
  type StoredReview,
} from "./reviewStore.ts";
import { type makeAttemptRun } from "./attemptRun.ts";

const decodeStarted = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ latest_revision: Schema.NullOr(Schema.Int) })),
);

const encodeLocal = Schema.encodeSync(Schema.fromJsonString(LocalSource));

export const storedAgentOf = (review: ReviewCore): StoredAgent => ({
  instance: review.instance,
  provider: review.provider,
  model: review.model,
  options: review.modelOptions,
});

/** Who started a review: the user, or auto mode for a review request. */
export type Origin = "user" | "auto" | "outside";

/** How an attempt starts: the agent it runs on, its row, and a new review's first attempt. */
export const makeAttemptStart = (
  {
    sql,
    agents,
    guideSettings,
    now,
    newId,
    publish,
    findSubject,
    insertAttempt,
    noteStartedBy,
  }: ReviewStore,
  { launch }: ReturnType<typeof makeAttemptRun>,
) => {
  /**
   * The agent a review runs on now: its own instance while that is on, else its kind's default
   * instance (same model), else the default agent. Nothing ready keeps the review's own, and the
   * attempt then says why it can't run.
   */
  const usableAgent = (agent: StoredAgent) =>
    Effect.gen(function* () {
      const instance = yield* agents.usable(agent.instance, agent.provider);
      if (instance === agent.instance) return agent;
      if (instance !== null) return { ...agent, instance };
      const catalog = yield* agents.catalog();
      const settings = yield* guideSettings.get();
      const chosen = effectiveSelection(catalog, settings.defaultAgent);
      const entry = chosen === null ? undefined : findAgentEntry(catalog, chosen.instance);
      return chosen === null || entry === undefined ? agent : { ...chosen, provider: entry.kind };
    }).pipe(Effect.catchTag("GuideSettingsError", () => Effect.succeed(agent)));

  /**
   * Moves the review from one of `from` to `preparing` with a new attempt and runs it.
   * A new `agent` replaces the review's; a different provider starts a new
   * conversation with it. Uninterruptible once the attempt is committed: it must reach its
   * worker, or nothing settles it until a restart (so is `ensureReview`).
   */
  const startAttempt = (
    review: StoredReview,
    trigger: AttemptTrigger,
    {
      from = STARTABLE,
      agent = storedAgentOf(review),
      batch = null,
      capture = null,
      source = null,
    }: {
      from?: ReadonlyArray<ReviewStatus["_tag"]>;
      agent?: StoredAgent;
      batch?: string | null;
      /** What a local attempt reviews. */
      capture?: LocalCapture | null;
      /** A local review's folder, base and head as this run asked for them. */
      source?: LocalSource | null;
    } = {},
  ) =>
    Effect.gen(function* () {
      // A turned-off or removed instance quietly gives way to its kind's default, else the default agent.
      // Reading the catalog can wait on providers; nothing is committed yet, so it can be interrupted.
      const usable = yield* Effect.interruptible(usableAgent(agent));
      const attemptId = AttemptId.make(yield* newId);
      const at = yield* now;
      // Another conversation group (another kind or config folder) starts a new conversation.
      const sameGroup = yield* Effect.interruptible(agents.sameGroup(usable.instance));
      // The revision number comes from the row the compare-and-set wins, not from the
      // caller's read, which a revision committed since would make stale.
      const revision = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            UPDATE reviews SET status = ${encodeStatus({ _tag: "preparing", attemptId })},
              current_attempt_id = ${attemptId}, updated_at = ${at},
              session_id = CASE WHEN instance_id IN ${sql.in(sameGroup)} THEN session_id ELSE NULL END,
              provider = ${usable.provider}, instance_id = ${usable.instance}, model = ${usable.model},
              model_options = ${encodeOptions(usable.options)}
            WHERE id = ${review.id} AND current_attempt_id IS NULL
              AND json_extract(status, '$._tag') IN ${sql.in(from)}
            RETURNING latest_revision`.pipe(Effect.flatMap(decodeStarted));
          const won = rows[0];
          if (won === undefined) return null;
          if (source !== null)
            yield* sql`UPDATE reviews SET local = ${encodeLocal(source)} WHERE id = ${review.id}`;
          const next = (won.latest_revision ?? 0) + 1;
          yield* insertAttempt({
            id: attemptId,
            reviewId: review.id,
            revision: next,
            trigger,
            agent: usable,
            at,
            batch,
            capture,
          });
          return next;
        }),
      );
      if (revision === null) return false;
      yield* noteStartedBy(review.key, review.id, attemptId);
      const started: StoredReview =
        review.kind === "local" && source !== null ? { ...review, local: source } : review;
      yield* launch(
        {
          ...started,
          provider: usable.provider,
          instance: usable.instance,
          sessionId: sameGroup.includes(review.instance) ? review.sessionId : null,
        },
        attemptId,
        revision,
        trigger,
      );
      yield* publish(review.key);
      return true;
    }).pipe(Effect.uninterruptible);

  const ensureReview = (
    subject: NewSubject,
    agent: StoredAgent,
    origin: Origin,
    batch: string | null = null,
  ) =>
    Effect.gen(function* () {
      const key = subject.key;
      const existing = yield* findSubject(subject);
      if (existing !== null) return { review: existing, created: false };
      const id = ReviewId.make(yield* newId);
      const attemptId = AttemptId.make(yield* newId);
      const at = yield* now;
      const created = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            INSERT INTO reviews (id, pr_key, account_id, local, provider, instance_id, model, model_options,
              origin, status, current_attempt_id, created_at, updated_at)
            VALUES (${id}, ${key}, ${subject.kind === "pull-request" ? subject.accountId : null},
              ${subject.kind === "local" ? encodeLocal(subject.local) : null}, ${agent.provider},
              ${agent.instance}, ${agent.model}, ${encodeOptions(agent.options)}, ${origin},
              ${encodeStatus({ _tag: "preparing", attemptId })}, ${attemptId}, ${at}, ${at})
            ON CONFLICT (pr_key) DO NOTHING RETURNING id`;
          if (rows.length === 0) return false;
          yield* insertAttempt({
            id: attemptId,
            reviewId: id,
            revision: 1,
            trigger: "first",
            agent,
            at,
            batch,
            capture: subject.kind === "local" ? subject.capture : null,
          });
          return true;
        }),
      );
      const review = yield* findSubject(subject);
      if (review === null)
        return yield* new ReviewError({ message: "prkit couldn't save the review." });
      if (created) {
        yield* Effect.logInfo("Review created").pipe(
          Effect.annotateLogs({
            reviewId: id,
            key,
            ...(subject.kind === "pull-request" ? { accountId: subject.accountId } : {}),
            origin,
            instance: agent.instance,
            model: agent.model ?? "default",
          }),
        );
        yield* noteStartedBy(key, id, attemptId);
        yield* launch(review, attemptId, 1, "first");
        yield* publish(key);
      }
      return { review, created };
    }).pipe(Effect.uninterruptible);

  return { startAttempt, ensureReview };
};
