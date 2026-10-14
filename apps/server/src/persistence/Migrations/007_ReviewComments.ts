import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per "finish your review" sent to GitHub. `github_review_id` is null while
  // the request is in flight; a row a crashed run left that way is checked against
  // GitHub's reviews before its drafts are offered again.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_submissions (
      id TEXT PRIMARY KEY NOT NULL,
      pr_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('comment', 'approve', 'request-changes')),
      body TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      started_at TEXT NOT NULL,
      github_review_id INTEGER,
      url TEXT
    )
  `;
  // Comments prkit holds per PR and account until the review is finished. A draft
  // with a `submission_id` is part of that submission's request.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pending_comments (
      id TEXT PRIMARY KEY NOT NULL,
      pr_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      start_side TEXT NOT NULL CHECK (start_side IN ('old', 'new')),
      start_line INTEGER NOT NULL,
      end_side TEXT NOT NULL CHECK (end_side IN ('old', 'new')),
      end_line INTEGER NOT NULL,
      snippet TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'sent-to-agent', 'resolved-by-agent')),
      submission_id TEXT REFERENCES review_submissions(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pending_comments_pr ON pending_comments (pr_key, account_id, state)`;
});
