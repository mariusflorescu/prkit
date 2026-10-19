import {
  AccountId as AccountIdSchema,
  AgentInstanceId,
  type AgentSelection,
  AgentProviderKind,
  AttemptConfig,
  AttemptId,
  checkContextOf,
  DiffSnapshot,
  DraftGuide,
  type DraftGuideResult,
  explicitModelOptions,
  findAgentModel,
  GuideNotFoundError,
  type GuideRevision,
  isLocalReviewKey,
  LocalReviewKey,
  LocalSource,
  ModelOptionSelection,
  NormalizedGuide,
  normalizeDraft,
  PullRequestKey,
  ReviewError,
  type ReviewFeedEntry,
  type ReviewFeedEvent,
  ReviewId,
  ReviewKey,
  ReviewStatus,
  refFromKey,
  reviewedSnapshot,
  RiskLevel,
  type TypicalDuration,
  withoutUnwrittenChapters,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { decodeReadable } from "../persistence/damagedRows.ts";
import { type CacheRef, type Checkout, RepoError } from "../repo/RepoCache.ts";
import { encodeOptions, type ReadyNotice, type ReviewStore } from "./reviewStore.ts";

const DraftRow = Schema.Struct({
  snapshot: Schema.NullOr(Schema.fromJsonString(DiffSnapshot)),
  draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)),
  config: Schema.NullOr(Schema.fromJsonString(AttemptConfig)),
  draft_version: Schema.Int,
});

const FeedRow = Schema.Struct({
  pr_key: PullRequestKey,
  account_id: AccountIdSchema,
  status: Schema.fromJsonString(ReviewStatus),
  latest_revision: Schema.NullOr(Schema.Int),
  /** Null with no revision and for revisions written before risk. */
  risk: Schema.NullOr(RiskLevel),
});

const DurationRow = Schema.Struct({ seconds: Schema.Number });

const GuideRow = Schema.Struct({
  revision: Schema.Int,
  head_sha: Schema.String,
  created_at: Schema.String,
  guide: Schema.fromJsonString(NormalizedGuide),
  snapshot: Schema.fromJsonString(DiffSnapshot),
  config: Schema.fromJsonString(AttemptConfig),
});

const RevisionContextRow = Schema.Struct({
  pr_key: ReviewKey,
  local: Schema.NullOr(Schema.fromJsonString(LocalSource)),
  provider: AgentProviderKind,
  instance_id: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  model_options: Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
  writer_provider: AgentProviderKind,
  writer_instance: AgentInstanceId,
  head_sha: Schema.String,
  guide: Schema.fromJsonString(NormalizedGuide),
  snapshot: Schema.fromJsonString(DiffSnapshot),
  config: Schema.fromJsonString(AttemptConfig),
  session_id: Schema.NullOr(Schema.String),
});

const readableFeed = decodeReadable("reviews", FeedRow);

const decodeDraft = Schema.decodeUnknownEffect(Schema.Array(DraftRow));

const decodeHeads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ head_sha: Schema.NullOr(Schema.String) })),
);

const decodeDurations = Schema.decodeUnknownEffect(Schema.Array(DurationRow));

const decodeGuides = Schema.decodeUnknownEffect(Schema.Array(GuideRow));

const decodeRevisionContext = Schema.decodeUnknownEffect(Schema.Array(RevisionContextRow));

const isLocalKey = Schema.is(LocalReviewKey);

const toFeedEntry = (row: typeof FeedRow.Type): ReviewFeedEntry => ({
  key: row.pr_key,
  accountId: row.account_id,
  status: row.status._tag,
  latestRevision: row.latest_revision,
  risk: row.risk,
});

/** A notice as the pull request feed sends it; a local review's ready isn't one of its events. */
const feedNotice = (notice: ReadyNotice): ReadonlyArray<ReviewFeedEvent> =>
  notice._tag === "stack-ready"
    ? [notice]
    : notice.review.kind === "pull-request"
      ? [
          {
            _tag: "ready",
            key: notice.review.key,
            accountId: notice.review.accountId,
            title: notice.title,
            revision: notice.revision,
            chapters: notice.chapters,
          },
        ]
      : [];

/** What a question about one accepted revision needs to know (`asks/Asks.ts`), read in one call. */
export interface RevisionContext {
  readonly reviewId: ReviewId;
  readonly key: ReviewKey;
  /**
   * What the prompt calls the change: "acme/widgets#12" for a pull request, "the local changes
   * in widgets on `main`" for a local review.
   */
  readonly label: string;
  readonly revision: number;
  readonly headSha: string;
  readonly guide: NormalizedGuide;
  /** The diff the guide explains: the attempt's snapshot without the files its settings skipped. */
  readonly snapshot: DiffSnapshot;
  /** The agent that wrote this revision. */
  readonly writer: {
    readonly instance: AgentInstanceId;
    readonly kind: AgentProviderKind;
    /**
     * Its conversation exactly as it stood when this revision was accepted, with the folder it
     * was made in. Null once no attempt after it can be ruled out of having added to it: one
     * ran an agent, or one hasn't finished.
     */
    readonly session: { readonly id: string; readonly cwd: string } | null;
  };
  /** The review's agent now, which answers with the review's model choice. */
  readonly agent: {
    readonly instance: AgentInstanceId;
    readonly kind: AgentProviderKind;
    readonly model: string | null;
    readonly options: ReadonlyArray<ModelOptionSelection>;
  };
  /** Checks the revision's code out at `dir`, a folder whose name no other checkout of the repository has. */
  readonly checkout: (dir: string) => Effect.Effect<Checkout, RepoError>;
}

/** What the app and outside agents read about a review: its guides, drafts, diffs, texts and feed. */
export const makeReviewReads = ({
  sql,
  repo,
  agents,
  changes,
  notices,
  dbFailures,
}: ReviewStore) => {
  const guide = (key: ReviewKey, revision: number | undefined) =>
    Effect.gen(function* () {
      const rows = yield* (
        revision === undefined
          ? sql`
            SELECT r.revision, r.head_sha, r.created_at, r.guide, a.snapshot, a.config FROM review_revisions r
            JOIN reviews v ON v.id = r.review_id JOIN review_attempts a ON a.id = r.attempt_id
            WHERE v.pr_key = ${key} ORDER BY r.revision DESC LIMIT 1`
          : sql`
            SELECT r.revision, r.head_sha, r.created_at, r.guide, a.snapshot, a.config FROM review_revisions r
            JOIN reviews v ON v.id = r.review_id JOIN review_attempts a ON a.id = r.attempt_id
            WHERE v.pr_key = ${key} AND r.revision = ${revision}`
      ).pipe(Effect.flatMap(decodeGuides));
      const row = rows[0];
      if (row === undefined)
        return yield* new GuideNotFoundError({
          key,
          message:
            revision === undefined
              ? isLocalReviewKey(key)
                ? "These local changes have no guide yet."
                : "This pull request has no guide yet."
              : `Guide revision ${revision} doesn't exist.`,
        });
      return {
        revision: row.revision,
        headSha: row.head_sha,
        createdAt: row.created_at,
        normalized: row.guide,
        snapshot: row.snapshot,
        config: row.config,
      } satisfies GuideRevision;
    }).pipe(Effect.catchTags(dbFailures));

  /** One accepted revision as a question about it needs it, or null when the review has no such revision. */
  const revisionContext = (reviewId: ReviewId, revision: number) =>
    Effect.gen(function* () {
      // rowid follows insertion, and a review's attempts run one at a time.
      const rows = yield* sql`
        SELECT v.pr_key, v.local, v.provider, v.instance_id, v.model, v.model_options,
          a.provider AS writer_provider, a.instance_id AS writer_instance,
          r.head_sha, r.guide, a.snapshot, a.config,
          CASE WHEN NOT EXISTS (
            SELECT 1 FROM review_attempts later
            WHERE later.review_id = r.review_id AND later.rowid > a.rowid
              AND (later.finished_at IS NULL OR later.agent_pid IS NOT NULL
                OR later.phase NOT IN ('queued', 'preparing-code'))
          ) THEN v.session_id END AS session_id
        FROM review_revisions r JOIN reviews v ON v.id = r.review_id
        JOIN review_attempts a ON a.id = r.attempt_id
        WHERE r.review_id = ${reviewId} AND r.revision = ${revision}`.pipe(
        Effect.flatMap(decodeRevisionContext),
      );
      const row = rows[0];
      if (row === undefined) return null;
      const key = row.pr_key;
      const ref = isLocalKey(key) ? null : refFromKey(key);
      const cache: CacheRef | null = isLocalKey(key)
        ? { _tag: "local", key }
        : ref === null
          ? null
          : { _tag: "pull-request", ref };
      return {
        reviewId,
        key,
        label:
          row.local !== null
            ? `the local changes in ${row.local.name} on ${row.local.branch === null ? "a detached HEAD" : `\`${row.local.branch}\``}`
            : ref === null
              ? key
              : `${ref.owner}/${ref.repo}#${ref.number}`,
        revision,
        headSha: row.head_sha,
        guide: row.guide,
        snapshot: reviewedSnapshot(row.snapshot, row.config.skipped),
        writer: {
          instance: row.writer_instance,
          kind: row.writer_provider,
          session:
            row.session_id === null
              ? null
              : { id: row.session_id, cwd: repo.worktreePath(reviewId) },
        },
        agent: {
          instance: row.instance_id,
          kind: row.provider,
          model: row.model,
          options: row.model_options,
        },
        checkout: (dir: string) =>
          cache === null
            ? Effect.fail(
                new RepoError({
                  reason: "repository",
                  message: "This pull request's key can't be read.",
                }),
              )
            : repo.ensureCheckout(cache, dir, row.head_sha),
      } satisfies RevisionContext;
    }).pipe(Effect.catchTags(dbFailures));

  /** The latest draft of an attempt, normalized for rendering. */
  const draft = (key: ReviewKey, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.snapshot, a.draft, a.config, a.draft_version FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key}`.pipe(Effect.flatMap(decodeDraft));
      const row = rows[0];
      const normalized =
        row?.draft == null || row.snapshot === null || row.config === null
          ? null
          : normalizeDraft(
              withoutUnwrittenChapters(row.draft),
              reviewedSnapshot(row.snapshot, row.config.skipped),
              checkContextOf(row.config),
            ).normalized;
      if (row === undefined || normalized === null)
        return yield* new GuideNotFoundError({
          key,
          message: "The agent hasn't shared a draft yet.",
        });
      return { attemptId, version: row.draft_version, normalized } satisfies DraftGuideResult;
    }).pipe(Effect.catchTags(dbFailures));

  /** The diff an attempt works on, once its head is fetched. */
  const diff = (key: ReviewKey, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.snapshot, a.draft, a.config, a.draft_version FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key}`.pipe(Effect.flatMap(decodeDraft));
      const snapshot = rows[0]?.snapshot ?? null;
      if (snapshot === null)
        return yield* new GuideNotFoundError({ key, message: "The code isn't checked out yet." });
      return snapshot;
    }).pipe(Effect.catchTags(dbFailures));

  /** The new side of paths at the commit an attempt read, from prkit's own copy of the repository. */
  const texts = (key: PullRequestKey, attemptId: AttemptId, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.head_sha FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key} AND r.local IS NULL`.pipe(
        Effect.flatMap(decodeHeads),
      );
      const headSha = rows[0]?.head_sha ?? null;
      const ref = refFromKey(key);
      if (headSha === null || ref === null)
        return yield* new GuideNotFoundError({ key, message: "The code isn't checked out yet." });
      return yield* repo.readTexts(ref, headSha, paths);
    }).pipe(
      Effect.catchTags({
        ...dbFailures,
        RepoError: (error) => Effect.fail(new ReviewError({ message: error.message })),
      }),
    );

  /**
   * The median click-to-guide time of past full guides by the same agent instance and
   * model, at the same settings, on diffs of a similar size (half to double the changed
   * lines). Null with fewer than two such guides: no estimate prkit can't back up. Guides
   * from before attempts recorded their settings never count.
   */
  const typicalDuration = (agent: AgentSelection, lines: number) =>
    Effect.gen(function* () {
      const model = findAgentModel(yield* agents.catalog(), agent.instance, agent.model);
      if (model === undefined) return null;
      const options = encodeOptions(explicitModelOptions(model, agent.options));
      const rows = yield* sql`
        SELECT (julianday(finished_at) - julianday(started_at)) * 86400.0 AS seconds FROM review_attempts
        WHERE outcome = 'accepted' AND instance_id = ${agent.instance} AND model = ${agent.model}
          AND model_options = ${options}
          AND trigger IN ('first', 'retry', 'rewritten', 'retargeted')
          AND changed_lines BETWEEN ${Math.max(0, Math.floor(lines / 2) - 20)} AND ${lines * 2 + 20}
        ORDER BY rowid DESC LIMIT 15`.pipe(Effect.flatMap(decodeDurations));
      if (rows.length < 2) return null;
      const sorted = rows.map((row) => row.seconds).toSorted((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? (sorted[middle] ?? 0)
          : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
      return { seconds: Math.round(median), samples: rows.length } satisfies TypicalDuration;
    }).pipe(Effect.catchTags(dbFailures));

  const feedEntry = (key: ReviewKey) =>
    sql`
      SELECT r.id, r.pr_key, r.account_id, r.status, r.latest_revision, json_extract(v.guide, '$.risk.level') AS risk
      FROM reviews r LEFT JOIN review_revisions v ON v.review_id = r.id AND v.revision = r.latest_revision
      WHERE r.pr_key = ${key} AND r.local IS NULL`.pipe(
      Effect.flatMap(readableFeed),
      Effect.map((rows) => rows.map(toFeedEntry)),
    );

  const readIndex = sql`
      SELECT r.id, r.pr_key, r.account_id, r.status, r.latest_revision, json_extract(v.guide, '$.risk.level') AS risk
      FROM reviews r LEFT JOIN review_revisions v ON v.review_id = r.id AND v.revision = r.latest_revision
      WHERE r.local IS NULL`.pipe(
    Effect.flatMap(readableFeed),
    Effect.map((rows) => rows.map(toFeedEntry)),
  );

  /** Every review of a pull request as the feed opens with it. */
  const index = () => readIndex.pipe(Effect.catchTag("SqlError", dbFailures.SqlError));

  /** The feed reads every guide at once, so its failures speak of all of them. */
  const feedFailures = {
    SqlError: () =>
      Effect.fail(new ReviewError({ message: "prkit can't read your guides right now." })),
  };

  /**
   * Every review's state for the whole app (inbox marks, tabs, notifications):
   * all of them first, then each change of status or revision, and `ready` notices.
   */
  const feed = (): Stream.Stream<ReviewFeedEvent, ReviewError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const changed = yield* PubSub.subscribe(changes);
        const ready = yield* PubSub.subscribe(notices);
        const all = yield* readIndex.pipe(Effect.catchTags(feedFailures));
        const sent = new Map(all.map((entry) => [entry.key, JSON.stringify(entry)]));
        const updates = Stream.fromSubscription(changed).pipe(
          Stream.mapEffect((change) => feedEntry(change.key).pipe(Effect.catchTags(feedFailures))),
          Stream.flatMap((entries) =>
            Stream.fromIterable(
              entries.flatMap((review): ReadonlyArray<ReviewFeedEvent> => {
                const encoded = JSON.stringify(review);
                if (sent.get(review.key) === encoded) return [];
                sent.set(review.key, encoded);
                return [{ _tag: "changed", review }];
              }),
            ),
          ),
        );
        const opening: ReviewFeedEvent = { _tag: "index", reviews: all };
        return Stream.concat(
          Stream.succeed(opening),
          Stream.merge(
            updates,
            Stream.fromSubscription(ready).pipe(
              Stream.flatMap((notice) => Stream.fromIterable(feedNotice(notice))),
            ),
          ),
        );
      }),
    );

  return { guide, revisionContext, draft, diff, texts, typicalDuration, index, feed };
};
