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
  yield* sql`
    CREATE TABLE IF NOT EXISTS outside_requests (
      tool TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tool, client_request_id)
    )`;
});
