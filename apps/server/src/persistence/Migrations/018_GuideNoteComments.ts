import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The guide note a draft was made from, as `noteKey` builds it. One draft per note in any
 * state, so a note can say what became of its draft; deleting the draft frees the note.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pending_comments ADD COLUMN note_key TEXT`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS pending_comments_note ON pending_comments (pr_key, account_id, note_key) WHERE note_key IS NOT NULL`;
});
