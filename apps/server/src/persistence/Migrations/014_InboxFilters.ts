import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The Inbox's search and filters (SavedInboxFilters JSON); NULL until the user sets one.
  yield* sql`ALTER TABLE workspace ADD COLUMN inbox_filters TEXT`;
});
