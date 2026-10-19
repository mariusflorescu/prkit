import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { migrationEntries } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const migrateThrough = (last: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => id <= last)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });

describe("026_ManualCheckTickCode", () => {
  it("keeps every tick made before ticks kept code, with no code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateThrough(25);
        yield* sql`INSERT INTO manual_check_ticks (subject, step, ticked, seq, decided_at) VALUES
          ('pull-request github.com/octocat github.com/acme/widgets#1', 'aa', 1, 1, '2026-10-01T09:00:00.000Z'),
          ('pull-request github.com/octocat github.com/acme/widgets#1', 'bb', 0, 2, '2026-10-01T09:00:00.000Z')`;
        yield* migrateThrough(26);
        const rows =
          yield* sql`SELECT step, code, ticked, seq FROM manual_check_ticks ORDER BY seq`;
        expect(rows).toEqual([
          { step: "aa", code: "", ticked: 1, seq: 1 },
          { step: "bb", code: "", ticked: 0, seq: 2 },
        ]);
        yield* sql`INSERT INTO manual_check_ticks (subject, step, code, ticked, seq, decided_at)
          VALUES ('pull-request github.com/octocat github.com/acme/widgets#1', 'aa', '[]', 1, 3, '2026-10-01T09:00:00.000Z')`;
        expect(yield* sql`SELECT count(*) AS n FROM manual_check_ticks`).toEqual([{ n: 3 }]);
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
        Effect.provideService(References.MinimumLogLevel, "Error"),
      ),
    ));
});
