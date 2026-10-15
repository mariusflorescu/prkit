import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as GuideSettingsStore from "../reviews/GuideSettingsStore.ts";
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

const Row = Schema.Struct({ provider: Schema.String, instance_id: Schema.String });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeSetting = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ value: Schema.String })),
);

const AT = "2026-10-01T09:00:00.000Z";

/** A database as prkit left it before instances: reviews, attempts, fixers and turns of both kinds. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, provider] of [
    ["review-claude", "claude"],
    ["review-codex", "codex"],
  ] as const) {
    yield* sql`INSERT INTO reviews (id, pr_key, account_id, provider, model, status, created_at, updated_at)
      VALUES (${id}, ${`github.com/acme/widgets#${id}`}, 'github.com/octocat', ${provider}, 'm',
        '{"_tag":"watching"}', ${AT}, ${AT})`;
    yield* sql`INSERT INTO review_attempts (id, review_id, revision, trigger, run_id, phase, started_at, provider, model)
      VALUES (${`${id}-1`}, ${id}, 1, 'first', 'run', 'done', ${AT}, ${provider}, 'm')`;
    yield* sql`INSERT INTO fixers (id, pr_key, account_id, provider, created_at, updated_at)
      VALUES (${`fixer-${provider}`}, ${`github.com/acme/widgets#${id}`}, 'github.com/octocat', ${provider}, ${AT}, ${AT})`;
    yield* sql`INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, created_at)
      VALUES (${`turn-${provider}`}, ${`fixer-${provider}`}, 'fix', '{}', 'user', '{"_tag":"failed"}', ${provider}, ${AT})`;
  }
  yield* sql`INSERT INTO settings (key, value) VALUES ('guides.defaultAgent',
    '{"provider":"codex","model":"gpt-6.1","options":[{"id":"reasoningEffort","value":"high"}]}')`;
});

const run = <A, E>(test: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    test.pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

describe("016_AgentInstances", () => {
  it("points every old row at its kind's default instance, and the default agent too", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateThrough(15);
        yield* seed;
        yield* migrateThrough(16);

        for (const table of ["reviews", "review_attempts", "fixers", "fixer_turns"]) {
          const rows =
            yield* sql`SELECT provider, instance_id FROM ${sql(table)} ORDER BY provider`.pipe(
              Effect.flatMap(decodeRows),
            );
          expect(rows, table).toEqual([
            { provider: "claude", instance_id: "claude" },
            { provider: "codex", instance_id: "codex" },
          ]);
        }

        const stored =
          yield* sql`SELECT value FROM settings WHERE key = 'guides.defaultAgent'`.pipe(
            Effect.flatMap(decodeSetting),
          );
        expect(stored[0]?.value).not.toContain("provider");
        const settings = yield* Effect.flatMap(GuideSettingsStore.make, (store) => store.get());
        expect(settings.defaultAgent).toEqual({
          instance: "codex",
          model: "gpt-6.1",
          options: [{ id: "reasoningEffort", value: "high" }],
        });
      }),
    ));

  it("leaves a default agent that was never chosen alone", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateThrough(15);
        yield* sql`INSERT INTO settings (key, value) VALUES ('guides.defaultAgent', 'null')`;
        yield* migrateThrough(16);
        const settings = yield* Effect.flatMap(GuideSettingsStore.make, (store) => store.get());
        expect(settings.defaultAgent).toBeNull();
      }),
    ));
});
