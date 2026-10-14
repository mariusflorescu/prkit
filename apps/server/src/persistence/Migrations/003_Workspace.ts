import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE open_pull_requests (key TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, position INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK (id = 1), active_key TEXT REFERENCES open_pull_requests(key) ON DELETE SET NULL)`;
  yield* sql`INSERT INTO workspace (id, active_key) VALUES (1, NULL)`;
});
