import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The last good answer of each GitHub read (inbox per account; detail, timeline,
  // threads and files per PR), so a relaunch shows data before any network call.
  // `kind = 'fingerprint'` rows hold the watcher's last fingerprint of a PR.
  // `config_dir` keeps an answer from being reused after the account moves.
  yield* sql`
    CREATE TABLE IF NOT EXISTS github_read_cache (
      kind TEXT NOT NULL,
      account_id TEXT NOT NULL,
      config_dir TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, account_id, key)
    )`;
});
