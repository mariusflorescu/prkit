import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The base branch the attempt was written against. When the layer below merges and
  // the PR targets the trunk, the next guide is written fresh instead of updated.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN base_ref TEXT`;
  // Guides started together for layers of one stack. Their attempts carry the batch
  // id, and the batch is announced once, when the last of them finishes.
  yield* sql`
    CREATE TABLE IF NOT EXISTS guide_batches (
      id TEXT PRIMARY KEY,
      origin_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      announced_at TEXT
    )`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN batch_id TEXT REFERENCES guide_batches (id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS review_attempts_batch ON review_attempts (batch_id)`;
});
