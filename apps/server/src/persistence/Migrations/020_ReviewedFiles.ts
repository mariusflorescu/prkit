import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The files the user marked reviewed. A row is one decision about one version of one file
 * (docs/internals/architecture.md "Reviewed files"). `subject` names who it is about, so a
 * review of something other than a pull request can share the table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `hunks` and `end_state` are empty when that side of the version is unknown. `seq` ranks
  // decisions, since two can share a millisecond; `decided_at` is only for people reading it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS reviewed_files (
      subject TEXT NOT NULL,
      path TEXT NOT NULL,
      hunks TEXT NOT NULL,
      end_state TEXT NOT NULL,
      reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
      seq INTEGER NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (subject, path, hunks, end_state),
      CHECK (hunks <> '' OR end_state <> '')
    )`;
});
