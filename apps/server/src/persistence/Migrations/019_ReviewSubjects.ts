import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Review subjects: a review is of a pull request, read through its account, or of local
 * changes, which have none. `pr_key` holds a `LocalReviewKey` when `local` is set.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Foreign keys stay on inside the migration's transaction, so `reviews` can't be rebuilt to
  // drop NOT NULL: the column is copied, dropped and renamed back, keeping every row's value.
  // The CHECK below names `account_id`, `local` and `pr_key`, so none of them can be copied,
  // dropped and renamed this way again.
  yield* sql`ALTER TABLE reviews ADD COLUMN account TEXT`;
  yield* sql`UPDATE reviews SET account = account_id`;
  yield* sql`ALTER TABLE reviews DROP COLUMN account_id`;
  yield* sql`ALTER TABLE reviews RENAME COLUMN account TO account_id`;
  // What a local review is about (JSON LocalSource); null for a pull request, which has an
  // account and a pull request's key.
  yield* sql`ALTER TABLE reviews ADD COLUMN local TEXT
    CHECK ((local IS NULL) = (account_id IS NOT NULL) AND (local IS NULL) = (pr_key NOT LIKE 'local:%'))`;
  // What one local run took (JSON LocalCapture); null for a pull request's attempts.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN capture TEXT`;
});
