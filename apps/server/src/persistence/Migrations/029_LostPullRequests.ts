import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Pull requests with reading state that GitHub no longer shows their account, and since when, so
 * their reading state goes once that has lasted a month (docs/internals/architecture.md
 * "Reviewed files"). `subject` is the reading state's own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE lost_pull_requests (
      subject TEXT PRIMARY KEY,
      since TEXT NOT NULL
    )`;
});
