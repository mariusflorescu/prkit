import { AttemptId, ReviewId, ReviewStatus } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { decodeEach } from "../persistence/damagedRows.ts";

const decodeStatuses = decodeEach(
  "reviews",
  Schema.Struct({ id: ReviewId, status: Schema.fromJsonString(ReviewStatus) }),
);
const decodeUnfinished = decodeEach(
  "review_attempts",
  Schema.Struct({
    id: AttemptId,
    review_id: ReviewId,
    agent_pid: Schema.NullOr(Schema.Int),
    agent_started: Schema.NullOr(Schema.String),
  }),
);
const decodeLatest = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: AttemptId })));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(ReviewStatus));

const stopped = (attemptId: AttemptId | null) =>
  encodeStatus({
    _tag: "failed",
    reason: "damaged",
    message:
      "A newer version of prkit may have saved it, or it was damaged, so prkit stopped this guide. Retry writes it again.",
    attemptId,
  });

/**
 * Startup, before anything else reads the reviews: one whose state prkit can't read (a newer
 * prkit's, or damaged), or whose unfinished attempt it can't read, stops at failed(damaged).
 * Nothing restarts it by itself; Retry does. Every other row then reads as usual, and a second
 * run changes nothing.
 */
export const stopUnreadableReviews = (at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [, statuses] = yield* sql`SELECT id, status FROM reviews`.pipe(
      Effect.flatMap(decodeStatuses),
    );
    for (const review of statuses) {
      // The latest attempt, so a local review's Retry writes that run's snapshot again.
      const [latest] = yield* sql`
        SELECT id FROM review_attempts WHERE review_id = ${review.id} ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.flatMap(decodeLatest),
      );
      yield* sql`
        UPDATE reviews SET status = ${stopped(latest?.id ?? null)}, current_attempt_id = NULL,
          updated_at = ${at}
        WHERE id = ${review.id}`;
      yield* Effect.logWarning("Stopped a review whose state prkit can't read").pipe(
        Effect.annotateLogs({ reviewId: review.id ?? "", problem: review.problem }),
      );
    }
    const [, attempts] = yield* sql`
      SELECT id, review_id, agent_pid, agent_started FROM review_attempts
      WHERE finished_at IS NULL`.pipe(Effect.flatMap(decodeUnfinished));
    // Its agent can't be told apart from any other process, so it is left alone.
    for (const attempt of attempts) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = 'damaged'
            WHERE id = ${attempt.id} AND finished_at IS NULL`;
          yield* sql`
            UPDATE reviews SET status = ${stopped(null)}, current_attempt_id = NULL,
              updated_at = ${at}
            WHERE current_attempt_id = ${attempt.id}`;
        }),
      );
      yield* Effect.logWarning("Stopped a guide whose unfinished attempt prkit can't read").pipe(
        Effect.annotateLogs({ attemptId: attempt.id ?? "", problem: attempt.problem }),
      );
    }
  });
