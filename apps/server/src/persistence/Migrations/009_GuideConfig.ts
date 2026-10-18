import { AttemptConfig, emptyScopeConfig, resolveGuideConfig } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const LegacyReview = Schema.Struct({
  id: Schema.String,
  pr_key: Schema.String,
  guidance: Schema.NullOr(Schema.String),
});
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(AttemptConfig));
const encodeGuidance = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String, mode: Schema.Literal("append") })),
);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Guide settings: one row per scope and section ('ignore', 'focus', 'guidance'), a JSON
  // value, and a version every save compares and sets. Scopes are 'global',
  // 'repository:<repositoryId>' and 'pull-request:<prKey>'.
  yield* sql`
    CREATE TABLE IF NOT EXISTS guide_config (
      scope TEXT NOT NULL,
      section TEXT NOT NULL,
      version INTEGER NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, section)
    )
  `;
  // Repositories by GitHub's id (`<host>/<databaseId>`), with the name they last had.
  yield* sql`
    CREATE TABLE IF NOT EXISTS guide_repositories (
      id TEXT PRIMARY KEY NOT NULL,
      host TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      seen_at TEXT NOT NULL
    )
  `;
  // The settings an attempt ran with (a JSON AttemptConfig), frozen when it fetched its
  // diff, and the hash the next attempt compares to decide on a fresh session.
  yield* sql`ALTER TABLE review_attempts ADD COLUMN config TEXT`;
  yield* sql`ALTER TABLE review_attempts ADD COLUMN config_hash TEXT`;

  // The review's focus note becomes its pull request's guidance block. Attempts that
  // already have a diff ran with exactly that note, so they record it as their settings
  // and an unchanged review keeps updating its guide in the same session.
  const reviews = yield* sql`SELECT id, pr_key, guidance FROM reviews`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyReview))),
  );
  for (const review of reviews) {
    const text = review.guidance?.trim() ?? "";
    if (text !== "")
      yield* sql`
        INSERT INTO guide_config (scope, section, version, value, updated_at)
        VALUES (${`pull-request:${review.pr_key}`}, 'guidance', 1,
          ${yield* encodeGuidance({ text, mode: "append" })}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT (scope, section) DO NOTHING`;
    const resolved = resolveGuideConfig({
      global: emptyScopeConfig,
      repository: null,
      pullRequest:
        text === ""
          ? null
          : { ...emptyScopeConfig, guidance: { version: 1, text, mode: "append" } },
    });
    const config = yield* encodeConfig({
      ...resolved,
      repository: null,
      skipped: [],
      signals: null,
    });
    yield* sql`
      UPDATE review_attempts SET config = ${config}, config_hash = ${resolved.hash}
      WHERE review_id = ${review.id} AND snapshot IS NOT NULL`;
  }
  yield* sql`ALTER TABLE reviews DROP COLUMN guidance`;
});
