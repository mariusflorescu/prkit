import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pull_request_action_preferences (repository TEXT PRIMARY KEY NOT NULL, merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'squash', 'rebase')), delete_branch INTEGER NOT NULL CHECK (delete_branch IN (0, 1)))`;
});
