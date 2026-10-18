import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Questions about a pull request, each on one accepted revision of its review, and pins next
 * to that revision, never in it. `session_id` is the answer's own conversation, a fork or a
 * new one, never the guide's. `run_id`, `agent_pid` and `agent_started` let startup stop an
 * answer a killed server left. One question per review is unfinished at a time.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ask_questions (
      id TEXT PRIMARY KEY NOT NULL,
      review_id TEXT NOT NULL REFERENCES reviews(id),
      revision INTEGER NOT NULL,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      asked_by TEXT,
      asked_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('starting', 'waiting', 'answering', 'answered', 'stopped', 'failed')),
      failure TEXT,
      message TEXT,
      instance_id TEXT,
      provider TEXT,
      basis TEXT,
      session_id TEXT,
      answer TEXT NOT NULL DEFAULT '[]',
      run_id TEXT NOT NULL,
      agent_pid INTEGER,
      agent_started TEXT,
      finished_at TEXT,
      pinned_at TEXT,
      FOREIGN KEY (review_id, revision) REFERENCES review_revisions(review_id, revision)
    )`;
  yield* sql`CREATE INDEX IF NOT EXISTS ask_questions_by_review ON ask_questions (review_id, asked_at)`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ask_questions_one_active ON ask_questions (review_id)
    WHERE state IN ('starting', 'waiting', 'answering')`;
});
