import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { FixerRow, TURN_COLUMNS, TurnRow } from "../fixers/fixerRows.ts";
import * as GuideSettingsStore from "../reviews/GuideSettingsStore.ts";
import { ReviewRow } from "../reviews/Reviews.ts";
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
        ${`{"_tag":"watching","headSha":"abc1234","checkedAt":"${AT}"}`}, ${AT}, ${AT})`;
    yield* sql`INSERT INTO review_attempts (id, review_id, revision, trigger, run_id, phase, started_at, provider, model)
      VALUES (${`${id}-1`}, ${id}, 1, 'first', 'run', 'done', ${AT}, ${provider}, 'm')`;
    yield* sql`INSERT INTO fixers (id, pr_key, account_id, provider, created_at, updated_at)
      VALUES (${`fixer-${provider}`}, ${`github.com/acme/widgets#${id}`}, 'github.com/octocat', ${provider}, ${AT}, ${AT})`;
    yield* sql`INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, created_at)
      VALUES (${`turn-${provider}`}, ${`fixer-${provider}`}, 'conflicts', '{"_tag":"conflicts","strategy":"merge"}', 'user',
        '{"_tag":"failed","reason":"agent","message":"The agent stopped."}', ${provider}, ${AT})`;
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

        // Each table read the way prkit reads it, so a row it can't decode fails here.
        const pairs = (rows: ReadonlyArray<{ provider: string; instance_id: string }>) =>
          rows.map(({ provider, instance_id }) => ({ provider, instance_id }));
        const both = [
          { provider: "claude", instance_id: "claude" },
          { provider: "codex", instance_id: "codex" },
        ];
        const reviews = yield* sql`SELECT * FROM reviews ORDER BY provider`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ReviewRow))),
        );
        expect(pairs(reviews)).toEqual(both);
        const fixers = yield* sql`SELECT * FROM fixers ORDER BY provider`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FixerRow))),
        );
        expect(pairs(fixers)).toEqual(both);
        const turns =
          yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns ORDER BY provider`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TurnRow))),
          );
        expect(pairs(turns)).toEqual(both);
        const attempts =
          yield* sql`SELECT provider, instance_id FROM review_attempts ORDER BY provider`.pipe(
            Effect.flatMap(decodeRows),
          );
        expect(attempts).toEqual(both);

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
