import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Outside agents: the client that started a guide attempt or a fix turn from outside, and
 * the answers to their `clientRequestId`s, so a retried call never adds its work twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN started_by TEXT`;
  yield* sql`ALTER TABLE fixer_turns ADD COLUMN started_by TEXT`;
  // One row per client request, kept a day: the input's hash tells a retry from a reused id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS outside_requests (
      tool TEXT NOT NULL,
      client TEXT NOT NULL,
      pr_key TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tool, client, pr_key, client_request_id)
    )`;
  yield* sql`CREATE INDEX IF NOT EXISTS outside_requests_created ON outside_requests (created_at)`;
});
