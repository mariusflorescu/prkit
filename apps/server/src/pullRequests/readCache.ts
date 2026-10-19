import { AccountId, type GitHubProblem } from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubRequestError, inBackground } from "../github/GitHubApi.ts";
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
const decodeAllRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...Row.fields, account_id: AccountId, key: Schema.String })),
);

/**
 * GitHub answers by account and key, bounded by entries and bytes. An answer is
 * fresh for `freshMs`; after that a read answers from cache at once and reads GitHub
 * again in the background, calling `changed` when the answer or its problem changes.
 * An invalidated answer is read again on the next read; if that read can't reach
 * GitHub, the old answer comes back with the problem. One read per key runs at a time,
 * so concurrent callers share it. With `persist`, answers also live in SQLite under
 * `name`, so a relaunch starts from them.
 */
export const makeReadCache = <V>(options: {
  readonly name: string;
  /** The answer as JSON text (`Schema.fromJsonString`), for its size and SQLite. */
  readonly json: Schema.Codec<V, string>;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly freshMs: number;
  readonly persist: boolean;
  readonly changed: (key: CacheKey) => Effect.Effect<void>;
}) => {
  const encode = Schema.encodeSync(options.json);
  const decode = Schema.decodeOption(options.json);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.scope;
    const entries = new Map<string, Entry<V>>();
    const revalidating = new Set<string>();
    const invalidatedAt = new Map<string, number>();
    const gate = makeKeyedGate<string>(1);
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
        const result = yield* inBackground(fetch).pipe(Effect.result);
        if (result._tag === "Success") {
          const unchanged =
            encode(result.success) === encode(before.value) && before.problem === null;
          yield* store(key, result.success, startedAt);
          if (!unchanged) yield* options.changed(key);
          return;
        }
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
            const result = yield* fetch.pipe(Effect.result);
            if (result._tag === "Success") return yield* store(key, result.success, startedAt);
            const problem = opts.fallback === false ? null : problemOf(result.failure);
            if (entry === undefined || problem === null) return yield* Effect.fail(result.failure);
            return yield* noteProblem(key, entry, problem);
          }),
        );
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

    /** Every persisted answer, without waiting for accounts to be discovered. */
    const persisted = sql`
      SELECT account_id, config_dir, key, value, fetched_at, invalidated FROM github_read_cache
      WHERE kind = ${options.name}`.pipe(
      Effect.flatMap(decodeAllRows),
      Effect.map((rows) =>
        rows.flatMap((row) =>
          Option.match(decode(row.value), {
            onNone: () => [],
            onSome: (value) => [
              {
                accountId: row.account_id,
                configDir: row.config_dir,
                key: row.key,
                cached: { value, fetchedAt: row.fetched_at, problem: null },
              },
            ],
          }),
        ),
      ),
      Effect.catchCause((cause) => persistFailed(cause).pipe(Effect.as([]))),
    );

    return { read, invalidate, peek: lookup, persisted };
  });
};
