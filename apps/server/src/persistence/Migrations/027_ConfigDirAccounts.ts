import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The logins each gh config directory listed the last time prkit could read it
 * (docs/internals/architecture.md "Accounts"). While a directory can't be read, its logins keep
 * their place in discovery, so another directory naming the same login can't take it over.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE github_config_dir_accounts (
      config_dir TEXT NOT NULL,
      host TEXT NOT NULL,
      login TEXT NOT NULL,
      PRIMARY KEY (config_dir, host, login)
    )`;
});
