import {
  type AgentSelection,
  type AttemptId,
  type AttemptSummary,
  type AttemptTrigger,
  type DoneReason,
  type FileContents,
  type FileSide,
  GuideNotFoundError,
  isLocalReviewKey,
  type LocalGenerateResult,
  type LocalHead,
  type LocalReview,
  type LocalReviewEntry,
  LocalReviewError,
  type LocalReviewFeedEvent,
  type LocalReviewKey,
  type LocalReviewSnapshot,
  type LocalReviewStatus,
  type LocalReviewWatchEvent,
  type LocalRun,
  LocalSource,
  type ReviewActivity,
  type ReviewCore,
  ReviewError,
  type ReviewId,
  type ReviewKey,
  ReviewStateError,
  type ReviewStatus,
  type RevisionSummary,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { makeKeyedGate } from "../github/keyedGate.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import type { RepoError } from "../repo/gitRun.ts";
import {
  LocalCapture,
  type LocalCaptureError,
  type LocalCaptureService,
} from "../repo/localCapture.ts";
import { decide } from "./lifecycle.ts";
import { Workspace } from "../workspace/Workspace.ts";
import { subjectKey } from "./reviewSubject.ts";
import type {
  Change,
  LocalStoredReview,
  NewSubject,
  Origin,
  ReadyNotice,
  StoredAgent,
  StoredReview,
} from "./Reviews.ts";

type DbError = SqlError | Schema.SchemaError;

/** What the review pipeline in Reviews.ts lends local reviews: closures it already has. */
export interface LocalPort {
  readonly findLocal: (key: LocalReviewKey) => Effect.Effect<LocalStoredReview | null, DbError>;
  /** Every local review, the latest changed first. */
  readonly locals: Effect.Effect<ReadonlyArray<LocalStoredReview>, DbError>;
  readonly progressOf: (reviewId: ReviewId) => Effect.Effect<
    {
      readonly attempt: AttemptSummary | null;
      readonly revisions: ReadonlyArray<RevisionSummary>;
    },
    DbError
  >;
  readonly activityOf: (
    attemptId: AttemptId,
  ) => Effect.Effect<ReadonlyArray<ReviewActivity>, DbError>;
  readonly captureOf: (attemptId: AttemptId) => Effect.Effect<LocalCapture | null, DbError>;
  readonly chooseAgent: (
    requested: AgentSelection | undefined,
    review: ReviewCore | null,
  ) => Effect.Effect<StoredAgent, ReviewError>;
  readonly ensureReview: (
    subject: NewSubject,
    agent: StoredAgent,
    origin: Origin,
  ) => Effect.Effect<
    { readonly review: StoredReview; readonly created: boolean },
    ReviewError | DbError
  >;
  readonly startAttempt: (
    review: StoredReview,
    trigger: AttemptTrigger,
    options: {
      readonly from?: ReadonlyArray<ReviewStatus["_tag"]>;
      readonly agent?: StoredAgent;
      readonly capture?: LocalCapture | null;
      readonly source?: LocalSource | null;
    },
  ) => Effect.Effect<boolean, DbError>;
  readonly end: (
    key: ReviewKey,
    reason: DoneReason,
  ) => Effect.Effect<void, ReviewStateError | DbError>;
  readonly publish: (key: ReviewKey) => Effect.Effect<void>;
  readonly changes: PubSub.PubSub<Change>;
  readonly notices: PubSub.PubSub<ReadyNotice>;
}

/** A local review by the folder it is about (the CLI and outside agents) or by its key (the app). */
export type LocalTarget =
  | {
      readonly _tag: "path";
      readonly path: string;
      /** A committed branch tip instead of the folder's working tree. */
      readonly branch?: string;
    }
  | { readonly _tag: "key"; readonly key: LocalReviewKey };

export interface LocalGenerateInput {
  readonly target: LocalTarget;
  /** Absent: the review's last base, else the first default that exists. */
  readonly base?: string;
  /** The author's own words about the change; absent keeps the last run's. */
  readonly description?: string;
  /** Write the guide again even when nothing changed. */
  readonly regenerate?: boolean;
  readonly agent?: AgentSelection;
}

const decodeRevisionCapture = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      revision: Schema.Int,
      capture: Schema.NullOr(Schema.fromJsonString(LocalCapture)),
    }),
  ),
);
const decodeLatestCapture = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ capture: Schema.NullOr(Schema.fromJsonString(LocalCapture)) })),
);
const encodeSource = Schema.encodeSync(Schema.fromJsonString(LocalSource));
const decodeHeads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ head_sha: Schema.NullOr(Schema.String) })),
);
const decodeRevisionCommits = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ head_sha: Schema.String, merge_base_sha: Schema.String })),
);

const dbFailures = {
  SqlError: () =>
    Effect.fail(new ReviewError({ message: "prkit couldn't read or save the review. Try again." })),
  SchemaError: () =>
    Effect.fail(new ReviewError({ message: "prkit read a damaged review record. Try again." })),
};

const running = (status: ReviewStatus) => status._tag === "preparing" || status._tag === "writing";

/** Nothing watches local changes: a current guide is ready, and only the user ends one. */
const statusOf = (status: ReviewStatus): LocalReviewStatus => {
  switch (status._tag) {
    case "preparing":
    case "writing":
    case "failed":
      return status;
    case "watching":
      return { _tag: "ready", checkedAt: status.checkedAt };
    case "done":
      return { _tag: "done", reason: "stopped" };
  }
};

const toLocalReview = (review: LocalStoredReview): LocalReview => ({
  id: review.id,
  key: review.key,
  provider: review.provider,
  instance: review.instance,
  model: review.model,
  modelOptions: review.modelOptions,
  sessionId: review.sessionId,
  status: statusOf(review.status),
  latestRevision: review.latestRevision,
  watchProblem: review.watchProblem,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
  source: review.local,
});

const toEntry = (review: LocalStoredReview): LocalReviewEntry => ({
  key: review.key,
  source: review.local,
  status: statusOf(review.status)._tag,
  latestRevision: review.latestRevision,
  updatedAt: review.updatedAt,
});

const toRun = (capture: LocalCapture | null): LocalRun | null =>
  capture === null
    ? null
    : {
        baseRef: capture.baseRef,
        baseSha: capture.baseSha,
        userHead: capture.userHead,
        head: capture.head,
        commitCount: capture.commitCount,
        uncommitted: capture.uncommitted,
        leftOut: capture.leftOut,
        description: capture.description,
        capturedAt: capture.capturedAt,
      };

const onWhat = (branch: string | null) => (branch === null ? "a detached HEAD" : `\`${branch}\``);
const titleOf = (source: { readonly name: string; readonly branch: string | null }) =>
  `${source.name} · ${source.branch ?? "detached HEAD"}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const sameSource = (left: LocalSource, right: LocalSource) =>
  left.name === right.name &&
  left.path === right.path &&
  left.branch === right.branch &&
  left.base === right.base &&
  left.head === right.head;
const sameOptions = (left: AgentSelection["options"], right: AgentSelection["options"]) => {
  const key = (options: AgentSelection["options"]) =>
    options
      .map((option) => `${option.id}=${String(option.value)}`)
      .toSorted()
      .join("\n");
  return key(left) === key(right);
};

/** The files a run left out, counted by why, for one calm line. */
const leftOutLine = (capture: LocalCapture) => {
  const count = (reason: LocalCapture["leftOut"][number]["reason"]) =>
    capture.leftOut.filter((file) => file.reason === reason).length;
  const parts = [
    [count("too-large"), "over 50 MB"],
    [count("filtered"), "stored through a git filter such as Git LFS"],
    [count("nested-repository"), "a repository of its own"],
  ] as const;
  const named = parts.flatMap(([number, why]) => (number === 0 ? [] : [`${number} ${why}`]));
  return named.length === 0
    ? ""
    : ` ${plural(capture.leftOut.length, "path")} ${capture.leftOut.length === 1 ? "is" : "are"} left out of the snapshot: ${named.join(", ")}.`;
};

/**
 * Commands and reads of reviews of local changes (docs/internals/architecture.md "Local
 * reviews"). The pipeline that writes a guide stays in Reviews.ts; this module owns how a
 * folder becomes a key, when the snapshot is taken (at request time, so every problem with
 * the repository reaches the caller before anything is queued), and how a stored review
 * reads as the local contracts. It reaches no account, GitHub or pull request module.
 */
export const makeLocalReviews = (port: LocalPort, capture: LocalCaptureService) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspace = yield* Workspace;
    /** Generate, retry and remove of one key run one at a time, from identify to adoption. */
    const command = makeKeyedGate<LocalReviewKey>(1);

    const captureFailures = {
      LocalCaptureError: (error: LocalCaptureError) =>
        Effect.fail(new LocalReviewError({ reason: error.reason, message: error.message })),
      RepoError: (error: RepoError) => Effect.fail(new ReviewError({ message: error.message })),
    };

    const notFound = (key: LocalReviewKey) =>
      new LocalReviewError({ reason: "not-found", message: `There's no local review \`${key}\`.` });

    /** The latest revision and the capture it was written from. */
    const revisionCapture = (reviewId: ReviewId) =>
      sql`
        SELECT r.revision, a.capture FROM review_revisions r
        JOIN review_attempts a ON a.id = r.attempt_id
        WHERE r.review_id = ${reviewId} ORDER BY r.revision DESC LIMIT 1`.pipe(
        Effect.flatMap(decodeRevisionCapture),
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined || row.capture === null
            ? null
            : { revision: row.revision, capture: row.capture };
        }),
      );

    /** The latest attempt's capture, whatever became of the attempt. */
    const latestCapture = (reviewId: ReviewId) =>
      sql`
        SELECT capture FROM review_attempts WHERE review_id = ${reviewId}
        ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.flatMap(decodeLatestCapture),
        Effect.map((rows) => rows[0]?.capture ?? null),
      );

    const snapshotOf = (key: LocalReviewKey) =>
      Effect.gen(function* () {
        const review = yield* port.findLocal(key);
        if (review === null)
          return {
            key,
            review: null,
            attempt: null,
            revisions: [],
            activity: [],
            run: null,
          } satisfies LocalReviewSnapshot;
        const { attempt, revisions } = yield* port.progressOf(review.id);
        return {
          key,
          review: toLocalReview(review),
          attempt,
          revisions,
          activity: attempt === null ? [] : yield* port.activityOf(attempt.id),
          run: attempt === null ? null : toRun(yield* port.captureOf(attempt.id)),
        } satisfies LocalReviewSnapshot;
      });

    const get = (key: LocalReviewKey) => snapshotOf(key).pipe(Effect.catchTags(dbFailures));

    /** A folder's or key's identity now, and what the run reads: the working tree or a branch tip. */
    const identityOf = (target: LocalTarget) =>
      Effect.gen(function* () {
        if (target._tag === "path") {
          const identity = yield* capture.identify(target.path, target.branch);
          const head: LocalHead = target.branch === undefined ? "working-tree" : "branch";
          return { identity, head };
        }
        const review = yield* port.findLocal(target.key);
        if (review === null) return yield* notFound(target.key);
        const { path, branch, head } = review.local;
        const identity = yield* capture.identify(
          path,
          head === "branch" && branch !== null ? branch : undefined,
        );
        if (identity.key !== target.key)
          return yield* new LocalReviewError({
            reason: "moved",
            message: `\`${path}\` is on ${onWhat(identity.branch)} now, not ${onWhat(branch)}. Switch back, or run prkit there for a new local review.`,
          });
        return { identity, head };
      });

    /** The key a folder's current branch (or the branch named) has, whether or not it has a review. */
    const keyOf = (target: LocalTarget) =>
      target._tag === "key"
        ? Effect.succeed(target.key)
        : capture.identify(target.path, target.branch).pipe(
            Effect.map((identity) => identity.key),
            Effect.catchTags(captureFailures),
          );

    /**
     * Snapshots the folder and starts a guide of it, or says why not. A request that brings
     * nothing new (the same trees as the latest revision, the same description and agent, no
     * `regenerate`) starts nothing and answers `unchanged`; one that finds a guide being
     * written answers `running`. Twice in a row converges: the second finds the first running,
     * or, once it is done, nothing new.
     */
    const generate = (input: LocalGenerateInput) =>
      Effect.gen(function* () {
        const { identity, head } = yield* identityOf(input.target);
        const key = identity.key;
        return yield* command(
          key,
          Effect.gen(function* () {
            const existing = yield* port.findLocal(key);
            const title = titleOf(identity);
            if (existing !== null && running(existing.status))
              return {
                outcome: "running",
                snapshot: yield* snapshotOf(key),
                message: `A guide for ${title} is already being written.`,
              } satisfies LocalGenerateResult;
            // The agent is checked before anything is copied.
            const agent = yield* port.chooseAgent(input.agent, existing);
            const previous = existing === null ? null : yield* revisionCapture(existing.id);
            const base = input.base ?? existing?.local.base ?? null;
            const description =
              input.description?.trim() ||
              (existing === null ? null : (yield* latestCapture(existing.id))?.description) ||
              null;
            const taken = yield* capture.capture({
              identity,
              base,
              head,
              previous: previous?.capture ?? null,
              description,
            });
            const source: LocalSource = {
              name: identity.name,
              path: identity.path,
              branch: identity.branch,
              base,
              head,
            };
            if (
              existing !== null &&
              previous !== null &&
              existing.status._tag === "watching" &&
              taken.sameAsPrevious &&
              input.regenerate !== true &&
              description === previous.capture.description &&
              agent.instance === existing.instance &&
              agent.model === existing.model &&
              sameOptions(agent.options, existing.modelOptions)
            ) {
              // Run again asks for what this run asked for, though it found nothing new.
              if (!sameSource(source, existing.local)) {
                yield* sql`UPDATE reviews SET local = ${encodeSource(source)} WHERE id = ${existing.id}`;
                yield* port.publish(key);
              }
              return {
                outcome: "unchanged",
                snapshot: yield* snapshotOf(key),
                message: `Nothing changed since revision ${previous.revision}. The guide is current.`,
              } satisfies LocalGenerateResult;
            }
            const started =
              existing === null
                ? (yield* port.ensureReview(
                    { kind: "local", key, local: source, capture: taken.capture },
                    agent,
                    (yield* StartedBy) === null ? "user" : "outside",
                  )).created
                : yield* port.startAttempt(
                    existing,
                    existing.latestRevision === null ? "first" : "retry",
                    { agent, capture: taken.capture, source },
                  );
            return {
              outcome: started ? "started" : "running",
              snapshot: yield* snapshotOf(key),
              message: started
                ? `Writing a guide for ${title} into ${taken.capture.baseRef}.${leftOutLine(taken.capture)}`
                : `A guide for ${title} is already being written.`,
            } satisfies LocalGenerateResult;
          }),
        );
      }).pipe(Effect.catchTags({ ...captureFailures, ...dbFailures }));

    /** A failed run again, on the snapshot it took: the folder may have moved on since. */
    const retry = (key: LocalReviewKey) =>
      command(
        key,
        Effect.gen(function* () {
          const review = yield* port.findLocal(key);
          const outcome = decide("retry", review?.status ?? null);
          if (outcome._tag === "reject")
            return yield* new ReviewStateError({ key, message: outcome.message });
          if (outcome._tag === "start" && review?.status._tag === "failed") {
            const attemptId = review.status.attemptId;
            const taken = attemptId === null ? null : yield* port.captureOf(attemptId);
            if (taken === null)
              return yield* new ReviewStateError({
                key,
                message: "This run kept no snapshot to write again. Run prkit again for a new one.",
              });
            yield* port.startAttempt(review, "retry", { from: ["failed"], capture: taken });
          }
          return yield* snapshotOf(key);
        }),
      ).pipe(Effect.catchTags(dbFailures));

    /**
     * Stops a guide being written. Revisions stay readable; with nothing running it changes
     * nothing. Behind the key's gate, so a run can't start while the stopped one is cleaned up.
     */
    const stop = (key: LocalReviewKey) =>
      command(
        key,
        Effect.gen(function* () {
          const review = yield* port.findLocal(key);
          if (review !== null && running(review.status))
            yield* port
              .end(key, "stopped")
              .pipe(Effect.catchTag("ReviewStateError", () => Effect.void));
          return yield* snapshotOf(key);
        }),
      ).pipe(Effect.catchTags(dbFailures));

    /**
     * Deletes the review, its revisions and questions, the reader's ticks and prkit's copy of its snapshots. Rows first, in one
     * transaction (foreign keys make a table this misses fail loudly), then the copy: a crash
     * between the two leaves a copy without a review, which startup's sweep removes. The app
     * removes through `Asks.removeLocalReview`, which stops the review's answers first.
     * `expected` is the review the caller saw (null for none): a review made under the key since
     * then is not the one being removed, so it and its copy stay.
     */
    const remove = (key: LocalReviewKey, expected: ReviewId | null) =>
      command(
        key,
        Effect.gen(function* () {
          const review = yield* port.findLocal(key);
          if (review !== null && review.id !== expected) return;
          if (review !== null) {
            if (running(review.status))
              yield* port
                .end(key, "stopped")
                .pipe(Effect.catchTag("ReviewStateError", () => Effect.void));
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM review_activity WHERE review_id = ${review.id}`;
                yield* sql`
                  DELETE FROM review_attempt_files WHERE attempt_id IN (
                    SELECT id FROM review_attempts WHERE review_id = ${review.id})`;
                yield* sql`DELETE FROM ask_questions WHERE review_id = ${review.id}`;
                yield* sql`DELETE FROM review_revisions WHERE review_id = ${review.id}`;
                yield* sql`DELETE FROM review_attempts WHERE review_id = ${review.id}`;
                yield* sql`DELETE FROM reviews WHERE id = ${review.id}`;
                yield* sql`
                  DELETE FROM manual_check_ticks WHERE subject = ${subjectKey({ _tag: "local", key })}`;
              }),
            );
            // The tab went with the rows; announcing the tabs now gives every window a copy newer
            // than any reply that still held it.
            yield* workspace
              .command({ kind: "close-local", key }, { focus: false })
              .pipe(
                Effect.catchTag("WorkspaceError", (error) =>
                  Effect.fail(new ReviewError({ message: error.message })),
                ),
              );
            yield* Effect.logInfo("Local review removed").pipe(
              Effect.annotateLogs({ reviewId: review.id }),
            );
            yield* port.publish(key);
          }
          yield* capture.forget(key);
        }),
      ).pipe(Effect.catchTags({ ...dbFailures, RepoError: captureFailures.RepoError }));

    /** A file as one revision's snapshot (new) or its base (old) holds it. */
    const fileContents = (input: {
      readonly key: LocalReviewKey;
      readonly revision: number;
      readonly path: string;
      readonly side: FileSide;
    }) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT r.head_sha, a.merge_base_sha FROM review_revisions r
          JOIN review_attempts a ON a.id = r.attempt_id JOIN reviews v ON v.id = r.review_id
          WHERE v.pr_key = ${input.key} AND v.local IS NOT NULL AND r.revision = ${input.revision}`.pipe(
          Effect.flatMap(decodeRevisionCommits),
        );
        const row = rows[0];
        if (row === undefined)
          return yield* new GuideNotFoundError({
            key: input.key,
            message: `Guide revision ${input.revision} doesn't exist.`,
          });
        const sha = input.side === "new" ? row.head_sha : row.merge_base_sha;
        const content = yield* capture.contents(input.key, sha, input.path);
        if (content === null)
          return yield* new GuideNotFoundError({
            key: input.key,
            message:
              input.side === "new"
                ? `\`${input.path}\` isn't in this revision.`
                : `\`${input.path}\` didn't exist before these changes.`,
          });
        return { content, sha } satisfies FileContents;
      }).pipe(Effect.catchTags({ ...dbFailures, RepoError: captureFailures.RepoError }));

    /** The new side of changed files at an attempt's snapshot, for the scope above each hunk. */
    const texts = (key: LocalReviewKey, attemptId: AttemptId, paths: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT a.head_sha FROM review_attempts a JOIN reviews r ON r.id = a.review_id
          WHERE a.id = ${attemptId} AND r.pr_key = ${key} AND r.local IS NOT NULL`.pipe(
          Effect.flatMap(decodeHeads),
        );
        const headSha = rows[0]?.head_sha ?? null;
        if (headSha === null)
          return yield* new GuideNotFoundError({ key, message: "This snapshot isn't ready yet." });
        return yield* capture.texts(key, headSha, paths);
      }).pipe(Effect.catchTags({ ...dbFailures, RepoError: captureFailures.RepoError }));

    const list = () =>
      port.locals.pipe(
        Effect.map((reviews) => reviews.map(toEntry)),
        Effect.catchTags(dbFailures),
      );

    /** A snapshot, then each change with the activity lines it added, until the review is removed. */
    const watch = (key: LocalReviewKey): Stream.Stream<LocalReviewWatchEvent, ReviewError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading, so nothing that lands in between is lost.
          const subscription = yield* PubSub.subscribe(port.changes);
          const first = yield* snapshotOf(key);
          let lastId = first.activity.reduce((max, line) => Math.max(max, line.id), 0);
          let present = first.review !== null;
          const updates = Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.key === key),
            Stream.mapEffect((change) =>
              Effect.gen(function* () {
                const review = yield* port.findLocal(key);
                if (review === null) {
                  const events: ReadonlyArray<LocalReviewWatchEvent> = present
                    ? [{ _tag: "removed" }]
                    : [];
                  present = false;
                  return events;
                }
                present = true;
                const { attempt, revisions } = yield* port.progressOf(review.id);
                const activity = change.activity.filter((line) => line.id > lastId);
                lastId = activity.reduce((max, line) => Math.max(max, line.id), lastId);
                const update: LocalReviewWatchEvent = {
                  _tag: "update",
                  review: toLocalReview(review),
                  attempt,
                  revisions,
                  activity,
                  run: attempt === null ? null : toRun(yield* port.captureOf(attempt.id)),
                };
                return [update];
              }).pipe(Effect.catchTags(dbFailures)),
            ),
            Stream.flatMap((events) => Stream.fromIterable(events)),
            Stream.takeUntil((event) => event._tag === "removed"),
          );
          const opening: LocalReviewWatchEvent = { _tag: "snapshot", snapshot: first };
          return Stream.concat(Stream.succeed(opening), updates);
        }).pipe(Effect.catchTags(dbFailures)),
      );

    /**
     * Every local review for the whole app: all of them first, then each change, `removed`
     * when one is deleted, and `ready` when a run's guide is accepted.
     */
    const feed = (): Stream.Stream<LocalReviewFeedEvent, ReviewError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading, so nothing that lands in between is lost.
          const changed = yield* PubSub.subscribe(port.changes);
          const ready = yield* PubSub.subscribe(port.notices);
          const all = (yield* port.locals).map(toEntry);
          const sent = new Map(all.map((entry) => [entry.key, JSON.stringify(entry)]));
          const updates = Stream.fromSubscription(changed).pipe(
            Stream.map((change) => change.key),
            Stream.filter(isLocalReviewKey),
            Stream.mapEffect((key) =>
              port.findLocal(key).pipe(
                Effect.map((review): ReadonlyArray<LocalReviewFeedEvent> => {
                  if (review === null) {
                    if (!sent.delete(key)) return [];
                    return [{ _tag: "removed", key }];
                  }
                  const entry = toEntry(review);
                  const encoded = JSON.stringify(entry);
                  if (sent.get(key) === encoded) return [];
                  sent.set(key, encoded);
                  return [{ _tag: "changed", review: entry }];
                }),
                Effect.catchTags(dbFailures),
              ),
            ),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          );
          const notices = Stream.fromSubscription(ready).pipe(
            Stream.flatMap((notice) =>
              Stream.fromIterable(
                notice._tag === "ready" && notice.review.kind === "local"
                  ? [
                      {
                        _tag: "ready",
                        key: notice.review.key,
                        title: notice.title,
                        revision: notice.revision,
                        chapters: notice.chapters,
                      } satisfies LocalReviewFeedEvent,
                    ]
                  : [],
              ),
            ),
          );
          const opening: LocalReviewFeedEvent = { _tag: "index", reviews: all };
          return Stream.concat(Stream.succeed(opening), Stream.merge(updates, notices));
        }).pipe(Effect.catchTags(dbFailures)),
      );

    return { keyOf, generate, get, retry, stop, remove, fileContents, texts, list, watch, feed };
  });

export type LocalReviews = Effect.Success<ReturnType<typeof makeLocalReviews>>;
