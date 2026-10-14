import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `status` is a JSON ReviewStatus. `current_attempt_id` is set exactly while the
  // review is preparing or writing; every state change compares and sets it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY NOT NULL,
      pr_key TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      current_attempt_id TEXT,
      latest_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // `run_id` names the server run that owns an unfinished attempt, so startup only
  // interrupts attempts a previous run left behind, and stops their agent if
  // `agent_pid` still names the process started at `agent_started`. `guide` is the
  // latest valid submit_guide, a JSON NormalizedGuide; `snapshot` is the JSON DiffSnapshot.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      review_id TEXT NOT NULL REFERENCES reviews(id),
      revision INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_pid INTEGER,
      agent_started TEXT,
      phase TEXT NOT NULL,
      head_sha TEXT,
      base_sha TEXT,
      merge_base_sha TEXT,
      snapshot TEXT,
      guide TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT,
      error TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS review_attempts_by_review ON review_attempts (review_id, started_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS review_attempts_unfinished ON review_attempts (finished_at) WHERE finished_at IS NULL`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_revisions (
      review_id TEXT NOT NULL REFERENCES reviews(id),
      revision INTEGER NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES review_attempts(id),
      head_sha TEXT NOT NULL,
      guide TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (review_id, revision)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL REFERENCES reviews(id),
      attempt_id TEXT NOT NULL REFERENCES review_attempts(id),
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS review_activity_by_review ON review_activity (review_id, id)`;
});
