import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

const database = (home: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
};

/**
 * Makes every write to one of prkit's tables fail inside its own SQLite, the way a full disk
 * or a damaged file would, until the returned function lets writes through again.
 */
export const refuseWrites = (home: string, table: string) => {
  const events = ["insert", "update", "delete"];
  const exec = (statements: ReadonlyArray<string>) => {
    const db = database(home);
    try {
      for (const statement of statements) db.exec(statement);
    } finally {
      db.close();
    }
  };
  exec(
    events.map(
      (event) =>
        `CREATE TRIGGER e2e_refuse_${event} BEFORE ${event.toUpperCase()} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'e2e refuses writes to ${table}'); END`,
    ),
  );
  return () => exec(events.map((event) => `DROP TRIGGER IF EXISTS e2e_refuse_${event}`));
};

/**
 * Takes SQLite's write lock the way another process writing would, so prkit's next save waits
 * on it (up to its 5 second busy timeout) until the returned function lets go.
 */
export const holdWrites = (home: string) => {
  const db = database(home);
  db.exec("BEGIN IMMEDIATE");
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
};
