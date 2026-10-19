import { AttemptId, LocalReviewKey, ReviewId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { turnTmpDir } from "../agents/commandReach.ts";
import { reapAgentGroup } from "../agents/agentProcess.ts";
import { decodeEach, decodeReadable } from "../persistence/damagedRows.ts";
import { unattended } from "./ContextPriority.ts";
import { stopUnreadableReviews } from "./unreadableReviews.ts";
import { cacheOf, ReviewRow, type ReviewStore, toStored } from "./reviewStore.ts";
import { type makeAttemptStart } from "./attemptStart.ts";

const IdRow = Schema.Struct({ id: Schema.String });

const StaleRow = Schema.Struct({
  id: AttemptId,
  review_id: ReviewId,
  agent_pid: Schema.NullOr(Schema.Int),
  agent_started: Schema.NullOr(Schema.String),
});

/** Lists read every row they can and leave a damaged one out (logged), so it fails alone. */
const readableReviews = decodeReadable("reviews", ReviewRow);

const decodeEachReview = decodeEach("reviews", ReviewRow);

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow));

const decodeStale = Schema.decodeUnknownEffect(Schema.Array(StaleRow));

const decodeLocalKeys = decodeEach("reviews", Schema.Struct({ pr_key: LocalReviewKey }));

/** The startup reconcile: attempts a crash or quit cut off, leftover checkouts and diffs, and local copies no review keeps. */
export const makeReconcile = (
  {
    sql,
    fs,
    path,
    repo,
    spawner,
    diffsDir,
    runId,
    now,
    captureOf,
    appendActivity,
    setStatus,
    batchOf,
  }: ReviewStore,
  { startAttempt }: ReturnType<typeof makeAttemptStart>,
) => {
  /**
   * Startup (docs/internals/architecture.md "Restarts"): attempts an earlier run left
   * unfinished become failed(interrupted) and their reviews start a new attempt;
   * checkouts of done or unknown reviews are removed. A second run changes nothing.
   */
  const reconcile = Effect.gen(function* () {
    const at = yield* now;
    yield* stopUnreadableReviews(at);
    const [readable, unreadable] = yield* sql`SELECT * FROM reviews`.pipe(
      Effect.flatMap(decodeEachReview),
    );
    const stored = new Map(readable.map((row) => [row.id, toStored(row)]));
    const stale = yield* sql`
      SELECT id, review_id, agent_pid, agent_started FROM review_attempts
      WHERE finished_at IS NULL AND run_id != ${runId}`.pipe(Effect.flatMap(decodeStale));
    const message = "prkit stopped while this guide was being written. Starting again.";
    for (const attempt of stale) {
      // An agent outlives a killed server; stop it before its session is resumed.
      if (attempt.agent_pid !== null && attempt.agent_started !== null) {
        const reaped = yield* reapAgentGroup(attempt.agent_pid, attempt.agent_started).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        if (reaped)
          yield* Effect.logInfo("Stopped an agent the previous run left behind").pipe(
            Effect.annotateLogs({ attemptId: attempt.id, pid: attempt.agent_pid }),
          );
      }
      const restarts = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = 'interrupted'
            WHERE id = ${attempt.id} AND finished_at IS NULL`;
          return yield* setStatus(
            attempt.review_id,
            attempt.id,
            { _tag: "failed", reason: "interrupted", message, attemptId: attempt.id },
            null,
          );
        }),
      );
      const review = stored.get(attempt.review_id);
      if (restarts && review !== undefined)
        yield* appendActivity(review.key, review.id, attempt.id, "error", message);
    }
    const interrupted = yield* sql`
      SELECT * FROM reviews WHERE json_extract(status, '$._tag') = 'failed'
        AND json_extract(status, '$.reason') = 'interrupted'`.pipe(Effect.flatMap(readableReviews));
    for (const row of interrupted) {
      const review = toStored(row);
      const attemptId = review.status._tag === "failed" ? review.status.attemptId : null;
      // A stack's guide picks up where it left off and is still announced with the others.
      const batch = attemptId === null ? null : yield* batchOf(attemptId);
      // Local changes are written again from the snapshot that attempt took, not the folder now.
      const capture =
        review.kind === "local" && attemptId !== null
          ? yield* captureOf(attemptId).pipe(
              // A snapshot prkit can't read leaves the review failed, and its Retry says so.
              Effect.catchTag("SchemaError", (error) =>
                Effect.logWarning("Left a local review failed: prkit can't read its snapshot").pipe(
                  Effect.annotateLogs({ attemptId, problem: error.message }),
                  Effect.as(null),
                ),
              ),
            )
          : null;
      if (review.kind === "local" && capture === null) continue;
      yield* unattended(startAttempt(review, "retry", { batch, capture }));
    }
    // A local review's checkout lives only while one of its attempts runs.
    const live = new Set(
      (yield* sql`
        SELECT id FROM reviews WHERE json_extract(status, '$._tag') != 'done'
          AND (local IS NULL OR current_attempt_id IS NOT NULL)`.pipe(
        Effect.flatMap(decodeIds),
      )).map((row) => row.id),
    );
    let removed = 0;
    // A review whose record can't be read keeps its checkout.
    const kept = new Set(unreadable.map((row) => row.id));
    for (const name of yield* repo.listWorktrees()) {
      if (live.has(name) || kept.has(name)) continue;
      const reviewId = ReviewId.make(name);
      // The cache to prune comes from prkit's own record of the review, never the checkout.
      const review = stored.get(reviewId);
      if (yield* repo.removeWorktree(reviewId, review === undefined ? null : cacheOf(review)))
        removed++;
    }
    const unfinished = new Set(
      (yield* sql`SELECT id FROM review_attempts WHERE finished_at IS NULL`.pipe(
        Effect.flatMap(decodeIds),
      )).map((row) => row.id),
    );
    // Each attempt's diffs are named after it, and its temp folder too (`turnTmpDir`).
    for (const name of yield* fs.readDirectory(diffsDir))
      if (!unfinished.has(name)) {
        yield* fs.remove(turnTmpDir(path, name), { recursive: true, force: true });
        yield* fs.remove(path.join(diffsDir, name), { recursive: true, force: true });
      }
    const [locals, unreadableLocals] = yield* sql`
      SELECT id, pr_key FROM reviews WHERE local IS NOT NULL`.pipe(Effect.flatMap(decodeLocalKeys));
    // A copy whose review's key can't be read looks like one whose review is gone: keep them all.
    yield* unreadableLocals.length > 0
      ? Effect.logWarning("Kept every local review's copy: prkit can't read a review's key")
      : repo.local
          .sweep(new Set(locals.map((row) => row.pr_key)))
          .pipe(Effect.catchTag("RepoError", (error) => Effect.logWarning(error.message)));
    yield* Effect.logInfo("Reconciled reviews").pipe(
      Effect.annotateLogs({
        interrupted: stale.length,
        restarted: interrupted.length,
        worktreesRemoved: removed,
      }),
    );
  });

  return { reconcile };
};
