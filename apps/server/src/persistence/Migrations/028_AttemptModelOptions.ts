import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The settings each attempt ran with (docs/internals/architecture.md "Domain model"), so a
 * typical time compares guides at the same settings. Attempts from before stay NULL and never count.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN model_options TEXT`;
});
