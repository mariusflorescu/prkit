import { FixerId, FixerTurnId } from "@prkit/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { parseProcesses, type ProcessHost, type ProcessRow } from "../agents/turnEnd.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeTurnLeftovers } from "./turnLeftovers.ts";

const Database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const FIXER = FixerId.make("fixer-1");
const EARLIER = FixerTurnId.make("turn-earlier");
const LEFT = parseProcesses(`  800     1   800       00:10 Tue Oct 13 12:10:20 2026`);

/** A machine where the processes in `running` keep running whatever prkit signals. */
const machine = (running: { rows: ReadonlyArray<ProcessRow> }) => {
  const signals: Array<string> = [];
  const host: ProcessHost = {
    list: Effect.sync(() => running.rows),
    environments: (pids) => Effect.succeed({ shown: new Set(pids), marked: new Set() }),
    signal: (pid, signal) => Effect.sync(() => signals.push(`${signal} ${pid}`)),
    pause: () => Effect.void,
  };
  return { host, signals };
};

/** A fixer with an earlier turn that started a minute ago. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);
  const started = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  yield* sql`INSERT INTO fixers (id, pr_key, account_id, provider, instance_id, created_at, updated_at)
    VALUES (${FIXER}, 'github.com/acme/widgets#1', 'github.com/octocat', 'claude', 'claude', ${at}, ${at})`;
  yield* sql`INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, instance_id,
      created_at, started_at)
    VALUES (${EARLIER}, ${FIXER}, 'fix', '{}', 'user', '{"_tag":"failed"}', 'claude', 'claude',
      ${started}, ${started})`;
});

const run = <A, E>(test: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    test.pipe(Effect.provide(Database), Effect.provideService(References.MinimumLogLevel, "Error")),
  );

describe("settle", () => {
  it("refuses to start a turn while what an earlier turn left still runs, and starts it once that has ended", () =>
    run(
      Effect.gen(function* () {
        const running = { rows: LEFT };
        const { host, signals } = machine(running);
        const leftovers = yield* makeTurnLeftovers(host);
        yield* seed;
        yield* leftovers.record(EARLIER, {
          _tag: "unfinished",
          reason: "prkit couldn't list processes: ps took too long",
          processes: LEFT.map((row) => ({ pid: row.pid, started: row.started, leader: true })),
        });
        const steps: Array<string> = [];
        const reset = Effect.sync(() => steps.push("reset"));

        const refused = yield* Effect.flip(leftovers.settle(FIXER));
        expect(refused).toMatchObject({
          reason: "checks",
          message: expect.stringContaining("processes 800 kept running"),
        });
        expect(signals[0]).toBe("SIGTERM 800");
        expect((yield* leftovers.pending(FIXER)).map((row) => row.id)).toEqual([EARLIER]);
        yield* leftovers.unlessLeftovers(FIXER, reset);
        expect(steps).toEqual([]);

        running.rows = [];
        yield* leftovers.settle(FIXER);
        expect(yield* leftovers.pending(FIXER)).toEqual([]);
        yield* leftovers.unlessLeftovers(FIXER, reset);
        expect(steps).toEqual(["reset"]);
      }),
    ));
});
