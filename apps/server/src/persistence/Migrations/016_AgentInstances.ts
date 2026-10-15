import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Agent instances: several setups of one agent side by side. Until now the kind was the
 * instance, so every row's instance is its kind's default one, whose id is the kind.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Only instances the user added or changed; each kind's default exists without a row.
  // `environment` is a JSON array of { name, value, sensitive }, with sensitive values
  // kept apart from the database (`agent-secrets.json`) and stored here as "".
  yield* sql`
    CREATE TABLE agent_instances (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      accent TEXT,
      enabled INTEGER NOT NULL,
      config_dir TEXT,
      binary_path TEXT,
      environment TEXT NOT NULL,
      login TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
  // Added and filled together: a row whose instance is missing would not decode.
  yield* sql`ALTER TABLE reviews ADD COLUMN instance_id TEXT`;
  yield* sql`UPDATE reviews SET instance_id = provider`;
  yield* sql`ALTER TABLE fixers ADD COLUMN instance_id TEXT`;
  yield* sql`UPDATE fixers SET instance_id = provider`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN instance_id TEXT`;
  yield* sql`UPDATE review_attempts SET instance_id = provider`;
  yield* sql`ALTER TABLE fixer_turns ADD COLUMN instance_id TEXT`;
  yield* sql`UPDATE fixer_turns SET instance_id = provider`;
  // The default agent named its kind; it names the kind's default instance now.
  yield* sql`
    UPDATE settings
    SET value = json_remove(json_set(value, '$.instance', json_extract(value, '$.provider')), '$.provider')
    WHERE key = 'guides.defaultAgent' AND json_type(value, '$.provider') = 'text'`;
});
