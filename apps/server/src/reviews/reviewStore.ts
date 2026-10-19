import {
  type AccountId,
  AccountId as AccountIdSchema,
  AgentInstanceId,
  type AgentSelection,
  AgentProviderKind,
  type AttemptFile,
  AttemptId,
  AttemptTrigger,
  type Guide,
  isLocalReviewKey,
  LocalReviewKey,
  LocalSource,
  ModelOptionSelection,
  PullRequestKey,
  type Review,
  type ReviewActivity,
  type ReviewCore,
  ReviewActivityKind,
  ReviewError,
  type ReviewFeedEvent,
  ReviewId,
  ReviewKey,
  ReviewPhase,
  type ReviewSnapshot,
  ReviewStatus,
  refFromKey,
} from "@prkit/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { Agents } from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { boundPort } from "../listenAddress.ts";
import { McpTokens } from "../mcp/McpTokens.ts";
import { decodeReadable } from "../persistence/damagedRows.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { LocalCapture } from "../repo/localCapture.ts";
import { type CacheRef, RepoCache } from "../repo/RepoCache.ts";
import { GuideConfigStore } from "./GuideConfigStore.ts";
import { GuideSettingsStore } from "./GuideSettingsStore.ts";
import { type DiffSection } from "./prompt.ts";
import { StartedBy } from "../outside/StartedBy.ts";

/** Ends an attempt as `failed(reason)`. */
export class AttemptFailure extends Schema.TaggedError<AttemptFailure>()("AttemptFailure", {
  reason: Schema.Literals([
    "account",
    "github",
    "repository",
    "agent-auth",
    "agent",
    "no-guide",
    "interrupted",
    "settings",
  ]),
  message: Schema.String,
}) {}

const ReviewFields = {
  id: ReviewId,
  provider: AgentProviderKind,
  instance_id: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  model_options: Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
  session_id: Schema.NullOr(Schema.String),
  status: Schema.fromJsonString(ReviewStatus),
  current_attempt_id: Schema.NullOr(AttemptId),
  latest_revision: Schema.NullOr(Schema.Int),
  watch_problem: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
};

export const PullRequestRow = Schema.Struct({
  ...ReviewFields,
  pr_key: PullRequestKey,
  account_id: AccountIdSchema,
  local: Schema.Null,
});

const LocalRow = Schema.Struct({
  ...ReviewFields,
  pr_key: LocalReviewKey,
  account_id: Schema.Null,
  local: Schema.fromJsonString(LocalSource),
});

/** A pull request's review with its account, or a review of local changes, with none. */
export const ReviewRow = Schema.Union([PullRequestRow, LocalRow]);

export const OutlineChapters = Schema.Array(
  Schema.Struct({ id: Schema.String, title: Schema.String, written: Schema.Boolean }),
);

export const AttemptRow = Schema.Struct({
  id: AttemptId,
  revision: Schema.Int,
  trigger: AttemptTrigger,
  phase: ReviewPhase,
  head_sha: Schema.NullOr(Schema.String),
  commits: Schema.NullOr(Schema.Int),
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  narration: Schema.NullOr(Schema.String),
  started_by: Schema.NullOr(Schema.String),
  draft_outline: Schema.NullOr(Schema.fromJsonString(OutlineChapters)),
  draft_version: Schema.Int,
});

const FileRow = Schema.Struct({
  path: Schema.String,
  previous_path: Schema.NullOr(Schema.String),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  additions: Schema.Int,
  deletions: Schema.Int,
  read_at: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});

const RevisionRow = Schema.Struct({
  revision: Schema.Int,
  attempt_id: AttemptId,
  trigger: AttemptTrigger,
  head_sha: Schema.String,
  created_at: Schema.String,
});

const ActivityRow = Schema.Struct({
  id: Schema.Int,
  attempt_id: AttemptId,
  at: Schema.String,
  kind: ReviewActivityKind,
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
});

const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewRow));

const readableLocals = decodeReadable("reviews", LocalRow);

const decodePullRequests = Schema.decodeUnknownEffect(Schema.Array(PullRequestRow));

const decodeLocals = Schema.decodeUnknownEffect(Schema.Array(LocalRow));

const decodeAttempts = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));

const decodeRevisions = Schema.decodeUnknownEffect(Schema.Array(RevisionRow));

const decodeActivity = Schema.decodeUnknownEffect(Schema.Array(ActivityRow));

const decodeFiles = Schema.decodeUnknownEffect(Schema.Array(FileRow));

const decodeInserted = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int })));

const decodeBatch = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ batch_id: Schema.NullOr(Schema.String) })),
);

const decodeOutcomes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      finished_at: Schema.NullOr(Schema.String),
      outcome: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeCaptures = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ capture: Schema.NullOr(Schema.fromJsonString(LocalCapture)) })),
);

const decodeClaimed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin_key: PullRequestKey, account_id: AccountIdSchema })),
);

export const encodeStatus = Schema.encodeSync(Schema.fromJsonString(ReviewStatus));

export const encodeOptions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
);

const encodeCapture = Schema.encodeSync(Schema.fromJsonString(LocalCapture));

/** A pull request's review. */
export interface PullRequestReview extends Review {
  readonly kind: "pull-request";
}

/** A review of local changes. It has no account to read anything through. */
export interface LocalStoredReview extends ReviewCore {
  readonly kind: "local";
  readonly key: LocalReviewKey;
  readonly local: LocalSource;
}

export type StoredReview = PullRequestReview | LocalStoredReview;

const coreOf = (row: typeof ReviewRow.Type): ReviewCore => ({
  id: row.id,
  provider: row.provider,
  instance: row.instance_id,
  model: row.model,
  modelOptions: row.model_options,
  sessionId: row.session_id,
  status: row.status,
  latestRevision: row.latest_revision,
  watchProblem: row.watch_problem,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toPullRequestReview = (row: typeof PullRequestRow.Type): PullRequestReview => ({
  kind: "pull-request",
  ...coreOf(row),
  key: row.pr_key,
  accountId: row.account_id,
});

const toLocalReview = (row: typeof LocalRow.Type): LocalStoredReview => ({
  kind: "local",
  ...coreOf(row),
  key: row.pr_key,
  local: row.local,
});

export const toStored = (row: typeof ReviewRow.Type): StoredReview =>
  row.local === null ? toPullRequestReview(row) : toLocalReview(row);

/** The review as the pull request APIs answer it. */
const toReview = (review: PullRequestReview): Review => ({
  id: review.id,
  key: review.key,
  accountId: review.accountId,
  provider: review.provider,
  instance: review.instance,
  model: review.model,
  modelOptions: review.modelOptions,
  sessionId: review.sessionId,
  status: review.status,
  latestRevision: review.latestRevision,
  watchProblem: review.watchProblem,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});

/** Where a review's objects live; null for a pull request whose key can't be read. */
export const cacheOf = (review: StoredReview): CacheRef | null => {
  if (review.kind === "local") return { _tag: "local", key: review.key };
  const ref = refFromKey(review.key);
  return ref === null ? null : { _tag: "pull-request", ref };
};

const toActivity = (row: typeof ActivityRow.Type): ReviewActivity => ({
  id: row.id,
  attemptId: row.attempt_id,
  at: row.at,
  kind: row.kind,
  text: row.text,
  detail: row.detail,
});

/** A review's agent: what the user picked, or `model` null for the agent's own default. */
export interface StoredAgent {
  readonly instance: AgentInstanceId;
  /** The instance's kind, so a review still names its agent after the instance is removed. */
  readonly provider: AgentProviderKind;
  readonly model: string | null;
  readonly options: AgentSelection["options"];
}

/** What a new review is about: a pull request, through an account, or local changes. */
export type NewSubject =
  | { readonly kind: "pull-request"; readonly key: PullRequestKey; readonly accountId: AccountId }
  | {
      readonly kind: "local";
      readonly key: LocalReviewKey;
      readonly local: LocalSource;
      /** What the first attempt reviews. */
      readonly capture: LocalCapture;
    };

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Change notices for `watch`: which review changed and the activity lines it gained. */
export interface Change {
  readonly key: ReviewKey;
  readonly activity: ReadonlyArray<ReviewActivity>;
}

/** A guide the user asked for (or auto mode started) was accepted, or a stack's batch finished. */
export type ReadyNotice =
  | {
      readonly _tag: "ready";
      readonly review: StoredReview;
      readonly title: string;
      readonly revision: number;
      readonly chapters: number;
    }
  | Extract<ReviewFeedEvent, { _tag: "stack-ready" }>;

/** Where an attempt's reads point, so a tool's paths can be matched to changed files. */
export interface ReadContext {
  readonly worktree: string;
  readonly diffFile: string;
  readonly sections: ReadonlyArray<DiffSection>;
  readonly paths: ReadonlySet<string>;
  /** Line ranges of the numbered diff the agent has seen so far, merged. */
  covered: ReadonlyArray<readonly [number, number]>;
}

/** A tool call still running: the files it is reading and the diff lines it prints. */
export interface PendingRead {
  readonly direct: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<string>;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

/** What every part of Reviews shares: its services, the state of running attempts, and the reads and writes of a review's rows. */
export const makeReviewStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const config = yield* ServerConfig.ServerConfig;

  const fs = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;

  const crypto = yield* Crypto.Crypto;

  const repo = yield* RepoCache;

  const agents = yield* Agents;

  const tokens = yield* McpTokens;

  const accounts = yield* GitHubAccounts;

  const api = yield* GitHubApi;

  const guideSettings = yield* GuideSettingsStore;

  const guideConfig = yield* GuideConfigStore;

  const pullRequests = yield* PullRequests;

  const server = yield* HttpServer.HttpServer;

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scope = yield* Effect.scope;

  const mcpUrl = `http://${config.host}:${Option.getOrElse(boundPort(server.address), () => config.port)}/mcp`;

  const instructions = yield* fs.readFileString(
    path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "instructions.md"),
  );

  const diffsDir = path.join(config.home, "diffs");

  yield* fs.makeDirectory(diffsDir, { recursive: true });

  /** Names this server run; startup only interrupts attempts other runs left unfinished. */
  const runId = yield* crypto.randomUUIDv4;

  /** Shared with fix turns; a slot covers preparing and writing. */
  const slots = agents.slots;

  const running = new Map<AttemptId, Fiber.Fiber<void>>();

  const phases = new Map<AttemptId, ReviewPhase>();

  const changes = yield* PubSub.unbounded<Change>();

  const notices = yield* PubSub.unbounded<ReadyNotice>();

  /** Each attempt's tool calls still running, by tool call id. */
  const reading = new Map<AttemptId, Map<string, PendingRead>>();

  /** Attempts whose streamed `submit_guide` is still adding chapters (`DraftOutline.growing`). */
  const growing = new Set<AttemptId>();

  const readContexts = new Map<AttemptId, ReadContext>();

  /** Each running attempt's last `submit_guide` input that failed its checks, for `revise_guide`. */
  const rejected = new Map<AttemptId, Guide>();

  /** One guide check at a time per attempt, so a call in flight sees the guide another stored. */
  const checking = makeKeyedGate<AttemptId>(1);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // The OS random source failing is not something a review can recover from.
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const publish = (key: ReviewKey, activity: ReadonlyArray<ReviewActivity> = []) =>
    PubSub.publish(changes, { key, activity }).pipe(Effect.asVoid);

  /** A pull request's review. A local review's key passed as a pull request's finds nothing. */
  const findReview = (key: PullRequestKey) =>
    sql`SELECT * FROM reviews WHERE pr_key = ${key} AND local IS NULL`.pipe(
      Effect.flatMap(decodePullRequests),
      Effect.map((rows) => (rows[0] === undefined ? null : toPullRequestReview(rows[0]))),
    );

  /** A local review. A pull request's key passed as a local review's finds nothing. */
  const findLocal = (key: LocalReviewKey) =>
    sql`SELECT * FROM reviews WHERE pr_key = ${key} AND local IS NOT NULL`.pipe(
      Effect.flatMap(decodeLocals),
      Effect.map((rows) => (rows[0] === undefined ? null : toLocalReview(rows[0]))),
    );

  /** The review a new subject would make, looked up among its own kind only. */
  const findSubject = (subject: NewSubject) =>
    subject.kind === "pull-request" ? findReview(subject.key) : findLocal(subject.key);

  /** Every local review, the latest changed first. */
  const locals = sql`SELECT * FROM reviews WHERE local IS NOT NULL ORDER BY updated_at DESC`.pipe(
    Effect.flatMap(readableLocals),
    Effect.map((rows) => rows.map(toLocalReview)),
  );

  /** The review a key names, among its own kind. */
  const findStored = (key: ReviewKey) => (isLocalReviewKey(key) ? findLocal(key) : findReview(key));

  const findReviewById = (id: ReviewId) =>
    sql`SELECT * FROM reviews WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeReviews),
      Effect.map((rows) => (rows[0] === undefined ? null : toStored(rows[0]))),
    );

  /** Status, latest attempt and every revision: everything but the activity feed. */
  const summaryOf = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const review = yield* findReview(key);
      if (review === null) return { key, review: null, attempt: null, revisions: [] };
      return { key, review: toReview(review), ...(yield* progressOf(review.id)) };
    });

  /** A review's latest attempt, as its progress is shown, and every revision. */
  const progressOf = (reviewId: ReviewId) =>
    Effect.gen(function* () {
      const attempts = yield* sql`
        SELECT id, revision, trigger, phase, head_sha, commits, started_at, finished_at, narration,
          started_by, draft_outline, draft_version FROM review_attempts
        WHERE review_id = ${reviewId} ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.flatMap(decodeAttempts),
      );
      const revisions = yield* sql`
        SELECT r.revision, r.attempt_id, a.trigger, r.head_sha, r.created_at FROM review_revisions r
        JOIN review_attempts a ON a.id = r.attempt_id
        WHERE r.review_id = ${reviewId} ORDER BY r.revision`.pipe(Effect.flatMap(decodeRevisions));
      const attempt = attempts[0];
      const files =
        attempt === undefined
          ? []
          : yield* sql`
            SELECT path, previous_path, status, additions, deletions, read_at, note
            FROM review_attempt_files WHERE attempt_id = ${attempt.id} ORDER BY position`.pipe(
              Effect.flatMap(decodeFiles),
            );
      const inFlight = new Set<string>();
      for (const pending of attempt === undefined ? [] : (reading.get(attempt.id)?.values() ?? []))
        for (const file of [...pending.direct, ...pending.sections]) inFlight.add(file);
      return {
        attempt:
          attempt === undefined
            ? null
            : {
                id: attempt.id,
                revision: attempt.revision,
                trigger: attempt.trigger,
                headSha: attempt.head_sha,
                commits: attempt.commits,
                phase: attempt.phase,
                startedAt: attempt.started_at,
                finishedAt: attempt.finished_at,
                narration: attempt.narration,
                startedBy: attempt.started_by,
                files: files.map((file): AttemptFile => ({
                  path: file.path,
                  previousPath: file.previous_path,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  read:
                    file.read_at !== null ? "read" : inFlight.has(file.path) ? "reading" : "unread",
                  note: file.note,
                })),
                draft:
                  attempt.draft_outline === null
                    ? null
                    : {
                        version: attempt.draft_version,
                        chapters: attempt.draft_outline,
                        growing: growing.has(attempt.id),
                      },
              },
        revisions: revisions.map((row) => ({
          revision: row.revision,
          attemptId: row.attempt_id,
          trigger: row.trigger,
          headSha: row.head_sha,
          createdAt: row.created_at,
        })),
      };
    });

  const snapshotOf = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const summary = yield* summaryOf(key);
      if (summary.review === null || summary.attempt === null) return { ...summary, activity: [] };
      const activity = yield* activityOf(summary.attempt.id);
      return { ...summary, activity } satisfies ReviewSnapshot;
    });

  /** An attempt's last 200 activity lines, oldest first. */
  const activityOf = (attemptId: AttemptId) =>
    sql`
      SELECT id, attempt_id, at, kind, text, detail FROM (
        SELECT * FROM review_activity WHERE attempt_id = ${attemptId} ORDER BY id DESC LIMIT 200
      ) ORDER BY id`.pipe(
      Effect.flatMap(decodeActivity),
      Effect.map((rows) => rows.map(toActivity)),
    );

  /** What a local attempt reviews; null for a pull request's. */
  const captureOf = (attemptId: AttemptId) =>
    sql`SELECT capture FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeCaptures),
      Effect.map((rows) => rows[0]?.capture ?? null),
    );

  const appendActivity = (
    key: ReviewKey,
    reviewId: ReviewId,
    attemptId: AttemptId,
    kind: ReviewActivity["kind"],
    text: string,
    detail: string | null = null,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        INSERT INTO review_activity (review_id, attempt_id, at, kind, text, detail)
        VALUES (${reviewId}, ${attemptId}, ${at}, ${kind}, ${text}, ${detail}) RETURNING id`.pipe(
        Effect.flatMap(decodeInserted),
      );
      const id = rows[0]?.id;
      if (id !== undefined) yield* publish(key, [{ id, attemptId, at, kind, text, detail }]);
    });

  const setPhase = (key: ReviewKey, reviewId: ReviewId, attemptId: AttemptId, phase: ReviewPhase) =>
    Effect.gen(function* () {
      if (phases.get(attemptId) === phase) return;
      phases.set(attemptId, phase);
      yield* sql`UPDATE review_attempts SET phase = ${phase} WHERE id = ${attemptId} AND finished_at IS NULL`;
      yield* appendActivity(key, reviewId, attemptId, "phase", phase);
    });

  /**
   * Compare-and-set on the current attempt id: a late result from an older attempt
   * changes nothing. Done is absorbing: only a new attempt leaves it.
   */
  const setStatus = (
    reviewId: ReviewId,
    expected: AttemptId | null,
    status: ReviewStatus,
    current: AttemptId | null,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE reviews SET status = ${encodeStatus(status)}, current_attempt_id = ${current}, updated_at = ${at}
        WHERE id = ${reviewId} AND current_attempt_id IS ${expected}
          AND json_extract(status, '$._tag') != 'done' RETURNING id`;
      return rows.length > 0;
    });

  const insertAttempt = (input: {
    readonly id: AttemptId;
    readonly reviewId: ReviewId;
    readonly revision: number;
    readonly trigger: AttemptTrigger;
    readonly agent: StoredAgent;
    readonly at: string;
    /** The stack batch the attempt was started in, announced with the others. */
    readonly batch: string | null;
    /** What a local attempt reviews; null for a pull request's. */
    readonly capture: LocalCapture | null;
  }) =>
    Effect.gen(function* () {
      const startedBy = yield* StartedBy;
      yield* sql`
        INSERT INTO review_attempts (id, review_id, revision, trigger, run_id, phase, started_at, provider,
          instance_id, model, batch_id, started_by, capture)
        VALUES (${input.id}, ${input.reviewId}, ${input.revision}, ${input.trigger}, ${runId}, 'preparing-code',
          ${input.at}, ${input.agent.provider}, ${input.agent.instance}, ${input.agent.model}, ${input.batch},
          ${startedBy}, ${input.capture === null ? null : encodeCapture(input.capture)})`;
    });

  /** Says in the attempt's activity which outside agent started it, if one did. */
  const noteStartedBy = (key: ReviewKey, reviewId: ReviewId, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const startedBy = yield* StartedBy;
      if (startedBy !== null)
        yield* appendActivity(key, reviewId, attemptId, "note", `Started from ${startedBy}`);
    });

  const batchOf = (attemptId: AttemptId) =>
    sql`SELECT batch_id FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeBatch),
      Effect.map((rows) => rows[0]?.batch_id ?? null),
    );

  /**
   * Announces a stack's batch once none of its attempts is running: one notice for
   * all of them, counted from each review's latest attempt in the batch. Claiming
   * `announced_at` makes a second call, or one after a restart, do nothing.
   */
  const settleBatch = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      const batch = yield* batchOf(attemptId);
      if (batch === null) return;
      const outcomes = yield* sql`
        SELECT a.finished_at, a.outcome FROM review_attempts a
        WHERE a.batch_id = ${batch} AND a.rowid = (
          SELECT MAX(b.rowid) FROM review_attempts b
          WHERE b.batch_id = a.batch_id AND b.review_id = a.review_id)`.pipe(
        Effect.flatMap(decodeOutcomes),
      );
      if (outcomes.some((row) => row.finished_at === null)) return;
      const at = yield* now;
      const claimed = yield* sql`
        UPDATE guide_batches SET announced_at = ${at}
        WHERE id = ${batch} AND announced_at IS NULL RETURNING origin_key, account_id`.pipe(
        Effect.flatMap(decodeClaimed),
      );
      const origin = claimed[0];
      if (origin === undefined) return;
      const ready = outcomes.filter((row) => row.outcome === "accepted").length;
      yield* Effect.logInfo("Stack guides finished").pipe(
        Effect.annotateLogs({ batch, ready, failed: outcomes.length - ready }),
      );
      yield* PubSub.publish(notices, {
        _tag: "stack-ready",
        key: origin.origin_key,
        accountId: origin.account_id,
        ready,
        failed: outcomes.length - ready,
      });
    }).pipe(
      Effect.catchTags({
        SqlError: (error) => Effect.logWarning("Couldn't settle the stack's guides", error),
        SchemaError: (error) => Effect.logWarning("Couldn't settle the stack's guides", error),
      }),
    );

  const dbFailures = {
    SqlError: () =>
      Effect.fail(new ReviewError({ message: "prkit couldn't read or save the review." })),
    SchemaError: () =>
      Effect.fail(new ReviewError({ message: "prkit read a damaged review record." })),
  };

  return {
    sql,
    fs,
    path,
    repo,
    agents,
    tokens,
    accounts,
    api,
    guideSettings,
    guideConfig,
    pullRequests,
    spawner,
    scope,
    mcpUrl,
    instructions,
    diffsDir,
    runId,
    slots,
    running,
    phases,
    changes,
    notices,
    reading,
    growing,
    readContexts,
    rejected,
    checking,
    now,
    newId,
    publish,
    findReview,
    findLocal,
    findSubject,
    locals,
    findStored,
    findReviewById,
    summaryOf,
    progressOf,
    snapshotOf,
    activityOf,
    captureOf,
    appendActivity,
    setPhase,
    setStatus,
    insertAttempt,
    noteStartedBy,
    batchOf,
    settleBatch,
    dbFailures,
  };
});

export type ReviewStore = Effect.Success<typeof makeReviewStore>;
