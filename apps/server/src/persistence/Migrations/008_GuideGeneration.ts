import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The review's agent selection. `model` stays NULL for reviews started before
  // prkit offered a model choice: those keep running on the agent's own default.
  yield* sql`ALTER TABLE reviews ADD COLUMN model TEXT`;
  yield* sql`ALTER TABLE reviews ADD COLUMN model_options TEXT NOT NULL DEFAULT '[]'`;
  // What the reviewer asked the guide to focus on; every revision reuses it.
  yield* sql`ALTER TABLE reviews ADD COLUMN guidance TEXT`;
  // `auto` when auto mode started the review, so it runs one at a time.
  yield* sql`ALTER TABLE reviews ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`;

  // Who ran the attempt and how big its diff was, for typical durations.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN provider TEXT`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN model TEXT`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN changed_lines INTEGER`;
  yield* sql`
    UPDATE review_attempts SET provider = (SELECT provider FROM reviews WHERE reviews.id = review_attempts.review_id)`;
  yield* sql`
    UPDATE review_attempts SET changed_lines = (
      SELECT SUM(json_extract(value, '$.additions') + json_extract(value, '$.deletions'))
      FROM json_each(review_attempts.snapshot, '$.files'))
    WHERE snapshot IS NOT NULL`;
  // The agent's latest progress line (`report_progress`), replaced each time.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN narration TEXT`;
  // The merged `submit_draft` calls as a JSON DraftGuide, its chapter outline, and a
  // version that grows by one per accepted call.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN draft TEXT`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN draft_outline TEXT`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0`;

  // One row per changed file of an attempt's snapshot, in diff order. `read_at` is
  // set by the agent's own reads that returned; `note` by `note_file`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_attempt_files (
      attempt_id TEXT NOT NULL REFERENCES review_attempts(id),
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      previous_path TEXT,
      status TEXT NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      read_at TEXT,
      note TEXT,
      PRIMARY KEY (attempt_id, path)
    )
  `;
  // The raw tool call behind an activity line, for the Details disclosure.
  yield* sql`ALTER TABLE review_activity ADD COLUMN detail TEXT`;
  // App settings as JSON values (Settings > Guides).
  yield* sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`;
});
