import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Set when prkit couldn't make sure that everything a turn's agent started has ended
  // (an Unfinished JSON: why, and what prkit tied to the turn); NULL once a later look ends it.
  yield* sql`ALTER TABLE fixer_turns ADD COLUMN unfinished_end TEXT`;
});
