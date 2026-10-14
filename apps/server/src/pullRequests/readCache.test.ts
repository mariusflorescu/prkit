import { AccountId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { GitHubRequestError } from "../github/GitHubApi.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { FRESH_MS } from "./detailReads.ts";
import { type Cached, type CacheKey, makeReadCache } from "./readCache.ts";

// The 10-minute freshness of PR reads, on a clock the test moves. Waiting ten real
// minutes against GitHub is not a test anyone runs.
const KEY: CacheKey = {
  accountId: AccountId.make("github.com/octocat"),
  configDir: "/gh/octocat",
  key: "github.com/acme/widgets#1",
};
const unreachable = new GitHubRequestError({
  accountId: KEY.accountId,
  reason: "network",
  message: "GitHub didn't answer.",
  status: null,
});

const Database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/** The detail cache's settings, a counter of GitHub reads, and the keys it announced as changed. */
const detailCache = Effect.gen(function* () {
  const changed = yield* Queue.unbounded<string>();
  const cache = yield* makeReadCache({
    name: "detail",
    json: Schema.fromJsonString(Schema.String),
    maxEntries: 10,
    maxBytes: 1_000_000,
    freshMs: FRESH_MS,
    persist: true,
    changed: (key) => Queue.offer(changed, key.key).pipe(Effect.asVoid),
  });
  const reads = yield* Ref.make(0);
  const github = (answer: Effect.Effect<string, GitHubRequestError>) =>
    Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(answer));
  const read = (answer: Effect.Effect<string, GitHubRequestError>) =>
    cache.read(KEY, github(answer)).pipe(Effect.map(shown));
  return { read, reads: Ref.get(reads), changed: Queue.take(changed) };
});

/** What a caller shows: the answer, when it was read, and why it wasn't read again. */
const shown = (cached: Cached<string>) => ({
  value: cached.value,
  fetchedAt: cached.fetchedAt,
  problem: cached.problem,
});

const run = <A, E>(test: Effect.Effect<A, E, Layer.Success<typeof Database> | Scope.Scope>) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(Database, TestClock.layer())),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    ),
  );

describe("makeReadCache", () => {
  it("answers from cache for 10 minutes, then at once from cache while it reads GitHub again", () =>
    run(
      Effect.gen(function* () {
        const detail = yield* detailCache;
        expect(yield* detail.read(Effect.succeed("first"))).toEqual({
          value: "first",
          fetchedAt: 0,
          problem: null,
        });

        yield* TestClock.adjust("599 seconds");
        expect(yield* detail.read(Effect.succeed("second"))).toEqual({
          value: "first",
          fetchedAt: 0,
          problem: null,
        });
        expect(yield* detail.reads).toBe(1);

        yield* TestClock.adjust("1 second");
        expect(yield* detail.read(Effect.succeed("second"))).toEqual({
          value: "first",
          fetchedAt: 0,
          problem: null,
        });
        expect(yield* detail.changed).toBe(KEY.key);
        expect(yield* detail.reads).toBe(2);
        expect(yield* detail.read(Effect.succeed("third"))).toEqual({
          value: "second",
          fetchedAt: 600_000,
          problem: null,
        });
        expect(yield* detail.reads).toBe(2);
      }),
    ));

  it("keeps the last good answer, with the reason, when GitHub can't be read again", () =>
    run(
      Effect.gen(function* () {
        const detail = yield* detailCache;
        yield* detail.read(Effect.succeed("first"));
        yield* TestClock.adjust("10 minutes");
        expect(yield* detail.read(Effect.fail(unreachable))).toEqual({
          value: "first",
          fetchedAt: 0,
          problem: null,
        });
        expect(yield* detail.changed).toBe(KEY.key);
        expect(yield* detail.read(Effect.fail(unreachable))).toEqual({
          value: "first",
          fetchedAt: 0,
          problem: { _tag: "unavailable", message: "GitHub didn't answer." },
        });
      }),
    ));
});
