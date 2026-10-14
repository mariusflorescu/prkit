import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Why the watcher's last read of the PR failed; cleared by the next read that works.
  yield* sql`ALTER TABLE reviews ADD COLUMN watch_problem TEXT`;
  // Commits since the previous revision's head, set with head_sha for a `new-commits` attempt.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN commits INTEGER`;
});
