import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The rows around each draft's rows, as JSON `{"before":[...],"after":[...]}`. NULL for a
 * draft written before prkit kept them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pending_comments ADD COLUMN context TEXT`;
});
