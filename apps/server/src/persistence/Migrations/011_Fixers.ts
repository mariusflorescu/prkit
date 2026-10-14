import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One writable agent session per PR, for review fixes and merge conflicts. `ended`
  // is null while the session is active, else merged, closed or stopped.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fixers (
      id TEXT PRIMARY KEY NOT NULL,
      pr_key TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      model_options TEXT NOT NULL DEFAULT '[]',
      session_id TEXT,
      ended TEXT CHECK (ended IN ('merged', 'closed', 'stopped')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // The fixer's queue. `work` is the JSON FixerWork request (its `report` and
  // `conflicted` start empty and live in their own columns); `status` is a JSON
  // FixerTurnStatus, changed only by compare-and-set on its tag. `run_id`,
  // `agent_pid` and `agent_started` let startup stop an agent a killed server left.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fixer_turns (
      id TEXT PRIMARY KEY NOT NULL,
      fixer_id TEXT NOT NULL REFERENCES fixers(id),
      kind TEXT NOT NULL CHECK (kind IN ('fix', 'conflicts', 'revert')),
      work TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      run_id TEXT,
      agent_pid INTEGER,
      agent_started TEXT,
      head_sha TEXT,
      base_sha TEXT,
      head_ref TEXT,
      base_ref TEXT,
      head_repo TEXT,
      commit_sha TEXT,
      commit_parents TEXT,
      commit_message TEXT,
      report TEXT,
      conflicted TEXT NOT NULL DEFAULT '[]',
      diff TEXT,
      narration TEXT,
      rounds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS fixer_turns_by_fixer ON fixer_turns (fixer_id, created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fixer_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL REFERENCES fixer_turns(id),
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      detail TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS fixer_activity_by_turn ON fixer_activity (turn_id, id)`;
  // Which turn holds a draft while it is with the agent.
  yield* sql`ALTER TABLE pending_comments ADD COLUMN fixer_turn_id TEXT`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fixer_repository_settings (
      repository TEXT PRIMARY KEY NOT NULL,
      push_automatically INTEGER NOT NULL DEFAULT 0 CHECK (push_automatically IN (0, 1)),
      resolve_automatically INTEGER NOT NULL DEFAULT 0 CHECK (resolve_automatically IN (0, 1))
    )
  `;
});
