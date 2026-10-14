import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a turn could run, decided when it checked out the PR head (TurnScripts JSON).
  yield* sql`ALTER TABLE fixer_turns ADD COLUMN scripts TEXT`;
  // Check scripts run on every PR in the repository, not only trusted authors' ones.
  yield* sql`ALTER TABLE fixer_repository_settings
    ADD COLUMN run_scripts_anywhere INTEGER NOT NULL DEFAULT 0 CHECK (run_scripts_anywhere IN (0, 1))`;
});
