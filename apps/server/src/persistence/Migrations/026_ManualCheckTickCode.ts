import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A tick also records the code its step exercised (docs/internals/architecture.md "Manual
 * checks"), so a step can read `changed`. A row is now one decision about one version of a
 * step made against one code. The key gains `code`, which SQLite can't add to a primary key,
 * so the table is rebuilt: every row so far keeps its answer with no code.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `code` is the canonical JSON of the code, empty when the step had none.
  yield* sql`
    CREATE TABLE manual_check_ticks_next (
      subject TEXT NOT NULL,
      step TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      ticked INTEGER NOT NULL CHECK (ticked IN (0, 1)),
      seq INTEGER NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (subject, step, code)
    )`;
  yield* sql`
    INSERT INTO manual_check_ticks_next (subject, step, ticked, seq, decided_at)
    SELECT subject, step, ticked, seq, decided_at FROM manual_check_ticks`;
  yield* sql`DROP TABLE manual_check_ticks`;
  yield* sql`ALTER TABLE manual_check_ticks_next RENAME TO manual_check_ticks`;
});
