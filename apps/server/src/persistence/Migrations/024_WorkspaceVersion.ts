import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A count of changes to the open tabs, so a window never shows an older copy over a newer one.
 * Triggers keep it, so every write counts, a removed review's tab going with it included.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspace ADD COLUMN version INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TRIGGER open_pull_requests_inserted AFTER INSERT ON open_pull_requests
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER open_pull_requests_updated AFTER UPDATE ON open_pull_requests
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER open_pull_requests_deleted AFTER DELETE ON open_pull_requests
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER open_local_reviews_inserted AFTER INSERT ON open_local_reviews
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER open_local_reviews_updated AFTER UPDATE ON open_local_reviews
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER open_local_reviews_deleted AFTER DELETE ON open_local_reviews
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
  yield* sql`CREATE TRIGGER workspace_updated AFTER UPDATE OF active_key, inbox_filters ON workspace
    BEGIN UPDATE workspace SET version = version + 1 WHERE id = 1; END`;
});
