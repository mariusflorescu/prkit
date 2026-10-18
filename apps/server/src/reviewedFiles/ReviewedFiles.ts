import {
  type AccountId,
  chapterReview,
  fileReviewState,
  fileVersion,
  GuideNotFoundError,
  indexMarks,
  type PullRequestKey,
  type ReviewableFile,
  type ReviewedDecision,
  reviewedDecision,
  ReviewedFilesError,
  type ReviewedFilesChange,
  ReviewedMarks,
  reviewProgress,
  compareVersions,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { makeKeyedGate } from "../github/keyedGate.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { subjectKey } from "../reviews/reviewSubject.ts";

const Row = Schema.Struct({
  path: Schema.String,
  hunks: Schema.String,
  end_state: Schema.String,
  reviewed: Schema.Int,
  seq: Schema.Int,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeNext = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ next: Schema.Int })]));
const decodeMarks = Schema.decodeUnknownEffect(ReviewedMarks);

/** Whose decisions: the account that read the PR, so another account never sees them. */
export type ReviewedTarget = { readonly key: PullRequestKey; readonly accountId: AccountId };
const subjectOf = ({ key, accountId }: ReviewedTarget) =>
  subjectKey({ _tag: "pull-request", key, accountId });

const rowStates = (files: ReadonlyArray<ReviewableFile>, marks: ReviewedMarks) => {
  const index = indexMarks(marks);
  return files.map((file) => ({
    path: file.path,
    previousPath: file.previousPath,
    state: fileReviewState(file, index),
  }));
};

export class ReviewedFiles extends Context.Service<ReviewedFiles, Effect.Success<typeof make>>()(
  "@prkit/server/reviewedFiles/ReviewedFiles",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pullRequests = yield* PullRequests;
  const reviews = yield* Reviews;
  const announced = yield* PubSub.unbounded<ReviewedFilesChange>();
  /** One writer per subject, so a decision is read and written against the same marks. */
  const withSubject = makeKeyedGate<string>(1);

  const storage =
    (target: ReviewedTarget, message: string) =>
    <A, R>(self: Effect.Effect<A, Schema.SchemaError | SqlError, R>) =>
      self.pipe(
        Effect.mapError(() => new ReviewedFilesError({ ...target, reason: "storage", message })),
      );
  const readFailure = (target: ReviewedTarget) =>
    storage(target, "prkit couldn't read your reviewed files. Try again.");
  const saveFailure = (target: ReviewedTarget) =>
    storage(target, "prkit couldn't save your reviewed files. Try again.");

  const readMarks = (target: ReviewedTarget) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT path, hunks, end_state, reviewed, seq FROM reviewed_files
        WHERE subject = ${subjectOf(target)} ORDER BY seq DESC, path`.pipe(
        Effect.flatMap(decodeRows),
      );
      return yield* decodeMarks({
        marks: rows.map((row) => ({
          path: row.path,
          version: {
            hunks: row.hunks === "" ? null : row.hunks,
            end: row.end_state === "" ? null : row.end_state,
          },
          reviewed: row.reviewed === 1,
          order: row.seq,
        })),
      });
    });

  const marks = (target: ReviewedTarget) => readMarks(target).pipe(readFailure(target));

  /**
   * Records what the user decided about these versions. A decision the newest matching mark
   * already says changes nothing, its order included, so repeating one is safe and a file
   * marked from either diff reads as marked from the other.
   */
  const decide = (target: ReviewedTarget, decision: ReviewedDecision) =>
    withSubject(
      subjectOf(target),
      Effect.gen(function* () {
        const subject = subjectOf(target);
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const index = indexMarks(yield* readMarks(target));
            const at = DateTime.formatIso(yield* DateTime.now);
            const [{ next }] = yield* sql`
              SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM reviewed_files`.pipe(
              Effect.flatMap(decodeNext),
            );
            let changed = false;
            for (const { path, version } of decision.files) {
              const decided = (index.get(path) ?? []).find(
                (mark) => compareVersions(mark.version, version) === "same",
              );
              if (decided?.reviewed === decision.reviewed) continue;
              yield* sql`
                INSERT INTO reviewed_files (subject, path, hunks, end_state, reviewed, seq, decided_at)
                VALUES (${subject}, ${path}, ${version.hunks ?? ""}, ${version.end ?? ""}, ${decision.reviewed ? 1 : 0}, ${next}, ${at})
                ON CONFLICT (subject, path, hunks, end_state)
                DO UPDATE SET reviewed = excluded.reviewed, seq = excluded.seq, decided_at = excluded.decided_at`;
              changed = true;
            }
            return changed;
          }),
        );
        if (changed)
          yield* PubSub.publish(announced, {
            _tag: "changed",
            key: target.key,
            accountId: target.accountId,
          });
        return yield* readMarks(target);
      }).pipe(saveFailure(target)),
    );

  /** Open while a window is: first `connected`, then one `changed` per saved decision. */
  const changes = (): Stream.Stream<ReviewedFilesChange> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before announcing, so nothing saved in between is lost.
        const subscription = yield* PubSub.subscribe(announced);
        const connected: ReviewedFilesChange = { _tag: "connected" };
        return Stream.concat(Stream.succeed(connected), Stream.fromSubscription(subscription));
      }),
    );

  /**
   * Every file's state for outside readers: the live files, or one accepted guide
   * revision's snapshot and its chapters. A revision whose review is bound to another
   * account is refused, so one account never reads another's private code.
   */
  const report = (target: ReviewedTarget, revision: number | undefined) =>
    Effect.gen(function* () {
      const all = yield* marks(target);
      if (revision === undefined) {
        const live = yield* pullRequests.files(target.key, target.accountId);
        const files = rowStates(live.files, all);
        return {
          headSha: live.headSha,
          revision: null,
          changedFiles: live.changedFiles,
          githubTruncated: live.files.length < live.changedFiles,
          files,
          progress: reviewProgress(files.map((file) => file.state)),
          chapters: [],
        };
      }
      const bound = (yield* reviews.get(target.key)).review;
      if (bound !== null && bound.accountId !== target.accountId)
        return yield* new GuideNotFoundError({
          key: target.key,
          message: `The guide for ${target.key} was written through ${bound.accountId}, not ${target.accountId}. Read it through that account.`,
        });
      const guide = yield* reviews.guide(target.key, revision);
      const files = rowStates(guide.snapshot.files, all);
      const stateOf = new Map(files.map((file) => [file.path, file.state]));
      const snapshotFile = new Map(guide.snapshot.files.map((file) => [file.path, file]));
      return {
        headSha: guide.headSha,
        revision: guide.revision,
        changedFiles: guide.snapshot.files.length,
        githubTruncated: false,
        files,
        progress: reviewProgress(files.map((file) => file.state)),
        chapters: guide.normalized.chapters.map((chapter) => {
          const members = chapter.files.flatMap((entry) => {
            const file = snapshotFile.get(entry.path);
            return file === undefined ? [] : [file];
          });
          const review = chapterReview(members, (file) => stateOf.get(file.path) ?? "unknown");
          return {
            id: chapter.id,
            title: chapter.title,
            state: review?.state ?? null,
            progress: review?.progress ?? reviewProgress([]),
          };
        }),
      };
    });

  /**
   * An outside write: these paths of the live diff, marked or unmarked in one decision.
   * `headSha` is the head the caller read, so it never marks a version it didn't see.
   */
  const decidePaths = (
    target: ReviewedTarget,
    headSha: string,
    paths: ReadonlyArray<string>,
    reviewed: boolean,
  ) =>
    Effect.gen(function* () {
      const live = yield* pullRequests.files(target.key, target.accountId);
      if (live.headSha !== headSha)
        return yield* new ReviewedFilesError({
          ...target,
          reason: "moved",
          message:
            "The pull request moved since you read it. Read it again with read_reviewed_files.",
        });
      const byPath = new Map(live.files.map((file) => [file.path, file]));
      const wanted = [...new Set(paths)];
      const chosen = wanted.flatMap((path) => {
        const file = byPath.get(path);
        return file === undefined ? [] : [file];
      });
      const unusable = wanted.filter((path) => {
        const file = byPath.get(path);
        return file === undefined || fileVersion(file) === null;
      });
      const decision = unusable.length === 0 ? reviewedDecision(chosen, reviewed) : null;
      if (decision === null)
        return yield* new ReviewedFilesError({
          ...target,
          reason: "not-a-changed-file",
          message:
            unusable.length === 0
              ? "Name at least one changed file."
              : `These aren't changed files prkit can mark in ${target.key}: ${unusable.join(", ")}. Read the paths with read_reviewed_files.`,
        });
      const after = yield* decide(target, decision);
      const index = indexMarks(after);
      return {
        headSha: live.headSha,
        changedFiles: live.changedFiles,
        githubTruncated: live.files.length < live.changedFiles,
        files: rowStates(chosen, after),
        progress: reviewProgress(live.files.map((file) => fileReviewState(file, index))),
      };
    });

  return { marks, decide, changes, report, decidePaths };
});

export const layer = Layer.effect(ReviewedFiles, make);
