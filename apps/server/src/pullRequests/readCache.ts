import { type AccountId, GitHubProblem } from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubRequestError, inBackground, throughBinding } from "../github/GitHubApi.ts";
import { isoAt } from "../github/budget.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";

/** Which account read it, through which gh config dir, and what (a PR key, or "" for the inbox). */
export interface CacheKey {
  readonly accountId: AccountId;
  readonly configDir: string;
  readonly key: string;
}

/** An answer and how old it is; `problem` says why it wasn't read again when it was due. */
export interface Cached<V> {
  readonly value: V;
  readonly fetchedAt: number;
  readonly problem: GitHubProblem | null;
}

interface Entry<V> extends Cached<V> {
  readonly configDir: string;
  /** Something changed on GitHub (fingerprint, a prkit write, Refresh): the next read fetches. */
  readonly invalidated: boolean;
  readonly bytes: number;
}

/** Larger answers stay in memory only. */
const PERSIST_MAX_BYTES = 4 * 1024 * 1024;

const isGitHubError = Schema.is(GitHubRequestError);
const encodeProblem = Schema.encodeSync(Schema.fromJsonString(GitHubProblem));

/**
 * The problem to show next to a cached answer; null when the failure must not
 * fall back to cache (no access any more, a refused token, a bad request).
 */
export const problemOf = <E>(error: E): GitHubProblem | null => {
  if (!isGitHubError(error)) return null;
  switch (error.reason) {
    case "rate-limited":
    case "reserved":
      return {
        _tag: error.reason,
        message: error.message,
        resetAt: isoAt(error.resetAt ?? 0),
      };
    case "network":
      return { _tag: "unavailable", message: error.message };
    default:
      return null;
  }
};

/** How an account's failed list read reads to the user, next to whatever it had before. */
export const readProblem = (error: GitHubRequestError): GitHubProblem => {
  switch (error.reason) {
    case "rate-limited":
    case "reserved":
      return { _tag: error.reason, message: error.message, resetAt: isoAt(error.resetAt ?? 0) };
    case "unauthorized":
      return { _tag: "account", message: error.message };
    default:
      return { _tag: "unavailable", message: error.message };
  }
};

const Row = Schema.Struct({
  config_dir: Schema.String,
  value: Schema.String,
  fetched_at: Schema.Number,
  invalidated: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

interface EntryOptions<V> {
  readonly name: string;
  /** The answer as JSON text (`Schema.fromJsonString`), for its size and SQLite. */
  readonly json: Schema.Codec<V, string>;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly persist: boolean;
}

/** The answers both caches below keep, in memory and with `persist` in SQLite. */
const makeEntries = <V>(options: EntryOptions<V>) => {
  const encode = Schema.encodeSync(options.json);
  const decode = Schema.decodeOption(options.json);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = new Map<string, Entry<V>>();
    const invalidatedAt = new Map<string, number>();
    let retainedBytes = 0;
    const id = (key: CacheKey) => `${key.accountId}:${key.key}`;
    const remove = (name: string) => {
      const entry = entries.get(name);
      if (entry === undefined) return;
      retainedBytes -= entry.bytes;
      entries.delete(name);
    };
    const persistFailed = <E>(cause: Cause.Cause<E>) =>
      Effect.logWarning("Couldn't persist a GitHub read", cause).pipe(
        Effect.annotateLogs({ cache: options.name }),
      );
    const remember = (key: CacheKey, entry: Omit<Entry<V>, "bytes">, text: string) =>
      Effect.gen(function* () {
        remove(id(key));
        // UTF-16 JSON size also accounts for field names and conservatively sizes shared strings.
        const bytes = text.length * 2;
        if (bytes > options.maxBytes) {
          yield* Effect.logWarning("Pull request cache value exceeds its byte limit").pipe(
            Effect.annotateLogs({ cache: options.name, bytes, maxBytes: options.maxBytes }),
          );
          return;
        }
        let evicted = 0;
        for (const oldest of entries.keys()) {
          if (entries.size < options.maxEntries && retainedBytes + bytes <= options.maxBytes) break;
          remove(oldest);
          evicted++;
        }
        entries.set(id(key), { ...entry, bytes });
        retainedBytes += bytes;
        if (evicted > 0)
          yield* Effect.logWarning("Pull request cache reached its limit").pipe(
            Effect.annotateLogs({
              cache: options.name,
              evicted,
              entries: entries.size,
              retainedBytes,
              maxEntries: options.maxEntries,
              maxBytes: options.maxBytes,
            }),
          );
      });
    /** Memory first, then the persisted answer from an earlier run. */
    const lookup = (key: CacheKey) =>
      Effect.gen(function* () {
        const name = id(key);
        const entry = entries.get(name);
        if (entry !== undefined) {
          entries.delete(name);
          entries.set(name, entry);
          return entry.configDir === key.configDir ? entry : undefined;
        }
        if (!options.persist) return undefined;
        const rows = yield* sql`
          SELECT config_dir, value, fetched_at, invalidated FROM github_read_cache
          WHERE kind = ${options.name} AND account_id = ${key.accountId} AND key = ${key.key}`.pipe(
          Effect.flatMap(decodeRows),
          Effect.catchCause((cause) => persistFailed(cause).pipe(Effect.as([]))),
        );
        const row = rows[0];
        if (row === undefined || row.config_dir !== key.configDir) return undefined;
        const value = Option.getOrUndefined(decode(row.value));
        if (value === undefined) return undefined;
        yield* remember(
          key,
          {
            value,
            fetchedAt: row.fetched_at,
            problem: null,
            configDir: row.config_dir,
            invalidated: row.invalidated !== 0,
          },
          row.value,
        );
        return entries.get(name);
      });
    /** An answer read from `startedAt` on; still stale if GitHub changed after that. */
    const store = (key: CacheKey, value: V, startedAt: number) =>
      Effect.gen(function* () {
        const fetchedAt = yield* Clock.currentTimeMillis;
        const text = encode(value);
        const invalidated = (invalidatedAt.get(id(key)) ?? 0) > startedAt;
        yield* remember(
          key,
          { value, fetchedAt, problem: null, configDir: key.configDir, invalidated },
          text,
        );
        if (options.persist && text.length * 2 <= PERSIST_MAX_BYTES)
          yield* sql`
            INSERT INTO github_read_cache (kind, account_id, config_dir, key, value, fetched_at, invalidated)
            VALUES (${options.name}, ${key.accountId}, ${key.configDir}, ${key.key}, ${text}, ${fetchedAt}, ${invalidated ? 1 : 0})
            ON CONFLICT (kind, account_id, key) DO UPDATE SET
              config_dir = excluded.config_dir, value = excluded.value,
              fetched_at = excluded.fetched_at, invalidated = excluded.invalidated`.pipe(
            Effect.catchCause(persistFailed),
          );
        return { value, fetchedAt, problem: null };
      });
    /** Marks a key's answer stale in memory and on disk, so its next read goes to GitHub. */
    const invalidate = (accountId: AccountId, key: string) =>
      Effect.gen(function* () {
        const name = `${accountId}:${key}`;
        invalidatedAt.set(name, yield* Clock.currentTimeMillis);
        const entry = entries.get(name);
        if (entry !== undefined) entries.set(name, { ...entry, invalidated: true });
        if (options.persist)
          yield* sql`
            UPDATE github_read_cache SET invalidated = 1
            WHERE kind = ${options.name} AND account_id = ${accountId} AND key = ${key}`.pipe(
            Effect.catchCause(persistFailed),
          );
      });
    return {
      id,
      entries,
      encode,
      lookup,
      store,
      invalidate,
      invalidatedAt: (key: CacheKey) => invalidatedAt.get(id(key)) ?? 0,
    };
  });
};

/**
 * GitHub answers by account and key, bounded by entries and bytes. An answer is
 * fresh for `freshMs`; after that a read answers from cache at once and reads GitHub
 * again in the background, calling `changed` when the answer or its problem changes.
 * An invalidated answer is read again on the next read; if that read can't reach
 * GitHub, the old answer comes back with the problem. One read per key runs at a time,
 * so concurrent callers share it. With `persist`, answers also live in SQLite under
 * `name`, so a relaunch starts from them.
 */
export const makeReadCache = <V>(
  options: EntryOptions<V> & {
    readonly freshMs: number;
    readonly changed: (key: CacheKey) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const { id, entries, encode, lookup, store, invalidate } = yield* makeEntries(options);
    const scope = yield* Effect.scope;
    const revalidating = new Set<string>();
    const gate = makeKeyedGate<string>(1);
    const noteProblem = (key: CacheKey, entry: Entry<V>, problem: GitHubProblem) =>
      Effect.sync(() => {
        const current = entries.get(id(key)) ?? entry;
        entries.set(id(key), { ...current, problem });
        return { value: current.value, fetchedAt: current.fetchedAt, problem };
      });
    /**
     * GitHub again in the background, once per key at a time; a changed answer or a
     * new problem is announced. It takes no gate, so reads keep answering from cache.
     */
    const revalidate = <E, R>(key: CacheKey, fetch: Effect.Effect<V, E, R>) =>
      Effect.gen(function* () {
        const before = yield* lookup(key);
        if (before === undefined) return;
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* inBackground(throughBinding(key)(fetch)).pipe(Effect.result);
        if (result._tag === "Success") {
          const unchanged =
            encode(result.success) === encode(before.value) && before.problem === null;
          yield* store(key, result.success, startedAt);
          if (!unchanged) yield* options.changed(key);
          return;
        }
        // The account is read through another directory now, whose answer this one isn't.
        if (isGitHubError(result.failure) && result.failure.reason === "moved") return;
        const problem = problemOf(result.failure) ?? {
          _tag: "unavailable" as const,
          message: isGitHubError(result.failure)
            ? result.failure.message
            : "prkit couldn't read GitHub again. Showing the last answer.",
        };
        if (before.problem?._tag === problem._tag) return;
        yield* noteProblem(key, before, problem);
        yield* options.changed(key);
      }).pipe(
        Effect.ensuring(Effect.sync(() => revalidating.delete(id(key)))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Background GitHub read failed", cause).pipe(
            Effect.annotateLogs({ cache: options.name, key: key.key, accountId: key.accountId }),
          ),
        ),
      );
    const usable = (found: Entry<V> | undefined, accept: ((value: V) => boolean) | undefined) =>
      found !== undefined && (accept?.(found.value) ?? true) ? found : undefined;

    const read = <E, R>(
      key: CacheKey,
      fetch: Effect.Effect<V, E, R>,
      opts: {
        /** Read GitHub now even when the answer is fresh. */
        readonly refresh?: boolean;
        /** False: a failed read fails instead of answering with the old value. */
        readonly fallback?: boolean;
        readonly accept?: (value: V) => boolean;
        /** An answer older than this is read again, like an invalidated one, even when it is still fresh. */
        readonly maxAgeMs?: number;
      } = {},
    ): Effect.Effect<Cached<V>, E, R> =>
      Effect.gen(function* () {
        const cached = usable(yield* lookup(key), opts.accept);
        const now = yield* Clock.currentTimeMillis;
        const tooOld = (entry: Entry<V>, at: number) =>
          opts.maxAgeMs !== undefined && at - entry.fetchedAt > opts.maxAgeMs;
        if (cached !== undefined && !cached.invalidated && !opts.refresh && !tooOld(cached, now)) {
          if (now - cached.fetchedAt >= options.freshMs && !revalidating.has(id(key))) {
            revalidating.add(id(key));
            yield* Effect.forkIn(revalidate(key, fetch), scope);
          }
          return cached;
        }
        // One GitHub read per key: a caller that waited here takes the answer read
        // while it waited.
        const askedAt = yield* Clock.currentTimeMillis;
        return yield* gate(
          id(key),
          Effect.gen(function* () {
            const entry = usable(yield* lookup(key), opts.accept);
            if (
              entry !== undefined &&
              !entry.invalidated &&
              !tooOld(entry, askedAt) &&
              (!opts.refresh || entry.fetchedAt >= askedAt)
            )
              return entry;
            const startedAt = yield* Clock.currentTimeMillis;
            const result = yield* throughBinding(key)(fetch).pipe(Effect.result);
            if (result._tag === "Success") return yield* store(key, result.success, startedAt);
            const problem = opts.fallback === false ? null : problemOf(result.failure);
            if (entry === undefined || problem === null) return yield* Effect.fail(result.failure);
            return yield* noteProblem(key, entry, problem);
          }),
        );
      });

    return { read, invalidate, peek: lookup };
  });

/** What one read brought: GitHub's answer, or why it couldn't give one. */
export type ReadOutcome<V> =
  | { readonly _tag: "read"; readonly value: V }
  | { readonly _tag: "failed"; readonly problem: GitHubProblem };

/** What a key holds now: the last good answer and when it was read, and why the last read failed. */
export interface Observation<V> {
  readonly kept: { readonly value: V; readonly fetchedAt: number } | undefined;
  readonly problem: GitHubProblem | null;
}

/**
 * How long a caller waits for GitHub. `snapshot` never waits. `cached` waits when nothing
 * is kept or the kept answer is invalidated. `refresh` waits for a read that starts now, or
 * for the one running when it succeeds.
 */
export type ObservedRead = "snapshot" | "cached" | "refresh";

/**
 * Answers kept like `makeReadCache`'s, for callers that show what is kept while GitHub is
 * slow or failing, such as each account's inbox. One read per key runs at a time, and every
 * caller that needs GitHub shares it and its outcome, failure included. A read tells
 * `changed` when it succeeds or fails for a new reason, whoever started it. Its failure is
 * kept until a read succeeds, next to the last good answer or alone when there is none.
 *
 * A key is due a read when nothing is kept, its answer is invalidated, or the answer is older
 * than `freshMs`. Any read starts a due read that isn't running, at the caller's priority, or
 * in the background for one that is only old. A `snapshot` doesn't start one after a read
 * failed, until the key is invalidated again: a window asks for snapshots on every change,
 * so retrying there would read GitHub on every other account's change.
 */
export const makeObservedReadCache = <V>(
  options: EntryOptions<V> & {
    readonly freshMs: number;
    readonly changed: (key: CacheKey) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const { id, lookup, store, invalidate, invalidatedAt } = yield* makeEntries(options);
    const scope = yield* Effect.scope;
    const running = new Map<
      string,
      { readonly configDir: string; readonly done: Deferred.Deferred<ReadOutcome<V>> }
    >();
    const failures = new Map<
      string,
      { readonly configDir: string; readonly problem: GitHubProblem; readonly at: number }
    >();
    /** The gh config dir each key was last read through; a read through an older one keeps nothing. */
    const readThrough = new Map<string, string>();
    const runningFor = (key: CacheKey) => {
      const claim = running.get(id(key));
      return claim?.configDir === key.configDir ? claim : undefined;
    };
    const failureOf = (key: CacheKey) => {
      const failure = failures.get(id(key));
      return failure?.configDir === key.configDir ? failure : undefined;
    };
    const observe = (key: CacheKey) =>
      lookup(key).pipe(
        Effect.map((entry): Observation<V> => ({
          kept:
            entry === undefined ? undefined : { value: entry.value, fetchedAt: entry.fetchedAt },
          problem: failureOf(key)?.problem ?? null,
        })),
      );
    const outcome = (key: CacheKey, result: ReadOutcome<V>, startedAt: number) =>
      Effect.gen(function* () {
        const name = id(key);
        if (readThrough.get(name) !== key.configDir) return;
        if (result._tag === "read") {
          yield* store(key, result.value, startedAt);
          failures.delete(name);
          yield* options.changed(key);
          return;
        }
        const before = failureOf(key)?.problem;
        const same =
          before !== undefined && encodeProblem(before) === encodeProblem(result.problem);
        failures.set(name, {
          configDir: key.configDir,
          problem: result.problem,
          at: yield* Clock.currentTimeMillis,
        });
        for (const oldest of failures.keys()) {
          if (failures.size <= options.maxEntries) break;
          failures.delete(oldest);
        }
        if (!same) yield* options.changed(key);
      });
    /**
     * Forked into the cache's scope, so no caller cancels a read others share, and claimed in the
     * same uninterruptible step, since a claim with no fiber would keep every later caller waiting.
     */
    const join = <R>(key: CacheKey, fetch: Effect.Effect<ReadOutcome<V>, never, R>) =>
      Effect.gen(function* () {
        const current = runningFor(key);
        if (current !== undefined) return current.done;
        const done = Deferred.makeUnsafe<ReadOutcome<V>>();
        const claim = { configDir: key.configDir, done };
        running.set(id(key), claim);
        readThrough.set(id(key), key.configDir);
        // Off the running list before anyone waiting hears, so a caller that needs a newer read starts one.
        const release = Effect.sync(() => {
          if (running.get(id(key)) === claim) running.delete(id(key));
        });
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const startedAt = yield* Clock.currentTimeMillis;
            const result = yield* throughBinding(key)(fetch);
            yield* outcome(key, result, startedAt);
            return result;
          }).pipe(
            Effect.interruptible,
            Effect.onExit((exit) => release.pipe(Effect.andThen(Deferred.done(done, exit)))),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("GitHub read failed", cause).pipe(
                  Effect.annotateLogs({
                    cache: options.name,
                    key: key.key,
                    accountId: key.accountId,
                  }),
                ),
            ),
          ),
          scope,
        );
        return done;
      }).pipe(Effect.uninterruptible);

    const read = <R>(
      key: CacheKey,
      fetch: Effect.Effect<ReadOutcome<V>, never, R>,
      mode: ObservedRead,
    ): Effect.Effect<Observation<V>, never, R> =>
      Effect.gen(function* () {
        if (mode === "refresh") {
          const current = runningFor(key);
          if (current === undefined || (yield* Deferred.await(current.done))._tag === "failed")
            yield* Deferred.await(yield* join(key, fetch));
          return yield* observe(key);
        }
        const entry = yield* lookup(key);
        const now = yield* Clock.currentTimeMillis;
        const missing = entry === undefined || entry.invalidated;
        if (!missing && now - entry.fetchedAt < options.freshMs) return yield* observe(key);
        if (mode === "cached" && missing) {
          const result = yield* Deferred.await(yield* join(key, fetch));
          // A read that started before the key was invalidated leaves it invalidated; the next one is newer.
          if (result._tag === "read" && (yield* lookup(key))?.invalidated === true)
            yield* Deferred.await(yield* join(key, fetch));
          return yield* observe(key);
        }
        const failed = failureOf(key);
        if (mode === "cached" || failed === undefined || failed.at < invalidatedAt(key))
          yield* join(key, missing ? fetch : inBackground(fetch));
        return yield* observe(key);
      });

    return { read, observe, invalidate, peek: lookup };
  });
