import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The manual check steps the reader ticked. A row is the current answer for one version of
 * one step (docs/internals/architecture.md "Manual checks"). `subject` names whose reading it
 * is, a pull request through one account or a review of local changes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `seq` ranks decisions, since two can share a millisecond; `decided_at` is only for people.
  yield* sql`
    CREATE TABLE IF NOT EXISTS manual_check_ticks (
      subject TEXT NOT NULL,
      step TEXT NOT NULL,
      ticked INTEGER NOT NULL CHECK (ticked IN (0, 1)),
      seq INTEGER NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (subject, step)
    )`;
});
