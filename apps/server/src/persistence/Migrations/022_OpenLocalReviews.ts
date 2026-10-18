import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The local reviews open as tabs, after the PR tabs. Removing a review closes its tab: the row
 * goes with the review's own row, so no tab can name a review that no longer exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE open_local_reviews (
      key TEXT PRIMARY KEY NOT NULL REFERENCES reviews(pr_key) ON DELETE CASCADE,
      position INTEGER NOT NULL
    )`;
});
