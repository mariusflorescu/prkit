import {
  type Account,
  type AccountId,
  type GitHubEvent,
  type GitHubProblem,
  InboxError,
  type InboxRead,
  InboxResult,
  type PullRequestKey,
  pullRequestKey,
  type PullRequestStatus,
  refFromKey,
} from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { isoAt } from "../github/budget.ts";
import { GitHubApi, inBackground } from "../github/GitHubApi.ts";
import { makeActions } from "./actions.ts";
import { FRESH_MS, makeDetailReads } from "./detailReads.ts";
import { PullRequestFingerprint, stackShape, statusOf } from "./fingerprint.ts";
import { accountEntries, CachedInboxEntry, mergeAccounts } from "./inboxEntries.ts";
import { InboxResponse, inboxQuery } from "./inboxQuery.ts";
import { type Cached, type CacheKey, makeReadCache, readProblem } from "./readCache.ts";
import { withDeadline } from "./readDeadline.ts";
import { makeRepositoryReads } from "./repositoryReads.ts";
import { makeReviewWaits, WaitsByNode, withWaits } from "./reviewWaits.ts";

/** An account's inbox and the facts behind its review waits, read together so they describe one moment. */
const AccountInbox = Schema.Struct({
  entries: Schema.Array(CachedInboxEntry),
  truncated: InboxResult.fields.truncated,
  waits: WaitsByNode,
});
type AccountInbox = typeof AccountInbox.Type;

const INBOX_DEADLINE = {
  name: "Inbox read",
  ms: 30_000,
  message: "GitHub took too long to refresh this account. Try refreshing.",
};

/** Persisted answers older than this are dropped at startup. */
const KEEP_MS = 14 * 24 * 60 * 60_000;

const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(PullRequestFingerprint));
const decodeFingerprint = Schema.decodeOption(Schema.fromJsonString(PullRequestFingerprint));

export class PullRequests extends Context.Service<PullRequests, Effect.Success<typeof make>>()(
  "@prkit/server/pullRequests/PullRequests",
) {}

export const make = Effect.gen(function* () {
  const accounts = yield* GitHubAccounts;
  const api = yield* GitHubApi;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const events = yield* PubSub.unbounded<GitHubEvent>();
  /** Windows holding `events` open; open PR tabs are fingerprinted only while one is visible. */
  const presence = yield* SubscriptionRef.make(0);
  const statuses = new Map<string, PullRequestStatus>();
  const fingerprints = new Map<string, string>();

  const startedAt = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM github_read_cache WHERE fetched_at < ${startedAt - KEEP_MS}`.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Couldn't prune the GitHub read cache", cause)),
  );
  for (const row of yield* sql`
    SELECT account_id, key, value FROM github_read_cache WHERE kind = 'fingerprint'`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ account_id: Schema.String, key: Schema.String, value: Schema.String }),
        ),
      ),
    ),
    Effect.orElseSucceed(() => []),
  ))
    fingerprints.set(`${row.account_id}:${row.key}`, row.value);

  const publish = (event: GitHubEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const detailReads = yield* makeDetailReads({
    changed: (key, accountId, status) =>
      Effect.gen(function* () {
        if (status !== null) statuses.set(`${accountId}:${key}`, status);
        yield* publish({ _tag: "changed", key, accountId, status });
      }),
    stackChanged: (accountId) => publish({ _tag: "stack", accountId }),
  });
  const inboxCache = yield* makeReadCache({
    name: "inbox",
    json: Schema.fromJsonString(AccountInbox),
    maxEntries: 32,
    maxBytes: 8 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed: () => publish({ _tag: "inbox" }),
  });
  /** A prkit write: the PR's answers, its stack and its account's inbox are read again next time. */
  const wrote = (key: PullRequestKey, accountId: AccountId) =>
    detailReads
      .invalidateStackOf(key, accountId)
      .pipe(
        Effect.andThen(detailReads.invalidate(key, accountId)),
        Effect.andThen(inboxCache.invalidate(accountId, "")),
        Effect.andThen(publish({ _tag: "inbox" })),
      );
  const actions = yield* makeActions({ ...detailReads, invalidate: wrote });
  const repositoryReads = yield* makeRepositoryReads({
    changed: publish({ _tag: "repositories" }),
  });

  const reviewWaits = yield* makeReviewWaits;
  const inboxKey = (account: Account): CacheKey => ({
    accountId: account.id,
    configDir: account.configDir,
    key: "",
  });
  /** The inbox, then the waits of its review requests: one value, so a rule never sees facts from another moment. */
  const fetchAccount = (account: Account) =>
    Effect.gen(function* () {
      const found = yield* api.graphql(account.id, inboxQuery, InboxResponse).pipe(
        Effect.map((response) => accountEntries(account, response)),
        withDeadline(account.id, INBOX_DEADLINE),
      );
      const previous = (yield* inboxCache.peek(inboxKey(account)))?.value.waits ?? {};
      const waits = yield* reviewWaits.read(account, found.entries, previous);
      return { ...found, waits } satisfies AccountInbox;
    });
  const row = (
    accountId: AccountId,
    cached: Cached<AccountInbox> | undefined,
    problem: GitHubProblem | null,
  ) => ({
    accountId,
    inbox: {
      entries: withWaits(accountId, cached?.value.entries ?? [], cached?.value.waits ?? {}),
      truncated: cached?.value.truncated ?? [],
    },
    fetchedAt: cached === undefined ? null : isoAt(cached.fetchedAt),
    problem,
  });
  /** One account's inbox: cached, read now, or the last answer with why it couldn't be read. */
  const readAccount = (account: Account, refresh: boolean) => {
    const key = inboxKey(account);
    if (account.status._tag === "error") {
      const problem = { _tag: "account" as const, message: account.status.message };
      return inboxCache.peek(key).pipe(Effect.map((cached) => row(account.id, cached, problem)));
    }
    return inboxCache.read(key, fetchAccount(account), { refresh }).pipe(
      Effect.map((cached) => row(account.id, cached, cached.problem)),
      Effect.catchTag("GitHubRequestError", (error) =>
        inboxCache
          .peek(key)
          .pipe(Effect.map((cached) => row(account.id, cached, readProblem(error)))),
      ),
    );
  };
  const result = (rows: ReadonlyArray<ReturnType<typeof row>>): InboxResult => ({
    entries: mergeAccounts(rows.flatMap((item) => item.inbox.entries)),
    accounts: rows.map((item) => ({
      accountId: item.accountId,
      count: item.inbox.entries.length,
      fetchedAt: item.fetchedAt,
      problem: item.problem,
    })),
    truncated: rows.flatMap((item) => item.inbox.truncated),
  });
  const readAll = (read: InboxRead) =>
    Effect.gen(function* () {
      const discovered = yield* accounts.list();
      const rows = yield* Effect.forEach(
        discovered.accounts,
        (account) =>
          readAccount(
            account,
            read._tag === "refresh" || (read._tag === "retry" && read.accountId === account.id),
          ),
        { concurrency: 4 },
      );
      return result(rows);
    });
  /**
   * The inbox across accounts. Before accounts are discovered (a relaunch), it answers
   * from the persisted inbox at once, then discovers and tells windows to read again.
   */
  const inbox = (read: InboxRead): Effect.Effect<InboxResult, InboxError> =>
    Effect.gen(function* () {
      if (read._tag === "cached" && (yield* accounts.known) === null) {
        const persisted = yield* inboxCache.persisted;
        if (persisted.length > 0) {
          yield* Effect.forkIn(
            inBackground(readAll(read)).pipe(
              Effect.andThen(publish({ _tag: "inbox" })),
              Effect.catchCause((cause) => Effect.logWarning("Inbox catch-up failed", cause)),
            ),
            scope,
          );
          return result(persisted.map((item) => row(item.accountId, item.cached, null)));
        }
      }
      return yield* readAll(read);
    }).pipe(
      Effect.catchTag("AccountsError", (error) =>
        Effect.fail(new InboxError({ message: error.message })),
      ),
    );

  /**
   * Every account whose last inbox has this PR, from the cache alone. The merged inbox keeps
   * one account per PR, so asking it would hide that a second account reaches it too.
   */
  const inboxAccountsOf = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const known = (yield* accounts.list()).accounts;
      const found = yield* Effect.forEach(known, (account) =>
        inboxCache
          .peek({ accountId: account.id, configDir: account.configDir, key: "" })
          .pipe(
            Effect.map((cached) =>
              (cached?.value.entries ?? []).some((entry) => pullRequestKey(entry.ref) === key)
                ? [account.id]
                : [],
            ),
          ),
      );
      return found.flat();
    }).pipe(
      Effect.catchTag("AccountsError", (error) =>
        Effect.fail(new InboxError({ message: error.message })),
      ),
    );

  /** What a stack strip shows of this PR changed: its stack, old and new, is read again. */
  const restack = (
    key: PullRequestKey,
    accountId: AccountId,
    reads: ReadonlyArray<PullRequestFingerprint | undefined>,
  ) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      if (ref === null) return;
      const stacks = new Set(
        reads.flatMap((read) => (read?.stack == null ? [] : [read.stack.number])),
      );
      for (const stack of stacks) yield* detailReads.invalidateStack(accountId, ref, stack);
      yield* publish({ _tag: "stack", accountId });
    });

  /**
   * Compares the watcher's read of a PR with the last one. A different fingerprint
   * marks the PR's cached reads stale and tells visible windows. The first one seen
   * for a PR is compared with the cached detail instead.
   */
  const observe = (
    key: PullRequestKey,
    accountId: AccountId,
    fingerprint: PullRequestFingerprint,
  ) =>
    Effect.gen(function* () {
      const id = `${accountId}:${key}`;
      const text = encodeFingerprint(fingerprint);
      const previous = fingerprints.get(id);
      const status = statusOf(key, accountId, fingerprint);
      const known = statuses.get(id);
      statuses.set(id, status);
      if (previous === text) {
        if (known === undefined) yield* publish({ _tag: "changed", key, accountId, status });
        return;
      }
      fingerprints.set(id, text);
      if (previous !== undefined) {
        const before = Option.getOrUndefined(decodeFingerprint(previous));
        if (before === undefined || stackShape(before) !== stackShape(fingerprint))
          yield* restack(key, accountId, [before, fingerprint]);
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO github_read_cache (kind, account_id, config_dir, key, value, fetched_at)
        VALUES ('fingerprint', ${accountId}, '', ${key}, ${text}, ${now})
        ON CONFLICT (kind, account_id, key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Couldn't save a PR fingerprint", cause)),
      );
      if (previous === undefined) {
        const cached = yield* detailReads
          .cachedDetail(key, accountId)
          .pipe(Effect.orElseSucceed(() => undefined));
        const behind =
          cached !== undefined &&
          (cached.value.updatedAt !== fingerprint.updatedAt ||
            cached.value.headSha !== fingerprint.headRefOid);
        if (!behind) {
          yield* publish({ _tag: "changed", key, accountId, status });
          return;
        }
      }
      yield* Effect.logInfo("Pull request changed on GitHub").pipe(
        Effect.annotateLogs({ key, accountId }),
      );
      yield* detailReads.invalidate(key, accountId, status);
    });

  /** Open while a window is visible: first the known statuses, then every change. */
  const watch = (): Stream.Stream<GitHubEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(events);
        yield* Effect.acquireRelease(
          SubscriptionRef.update(presence, (count) => count + 1),
          () => SubscriptionRef.update(presence, (count) => count - 1),
        );
        const opening: GitHubEvent = { _tag: "opened", statuses: [...statuses.values()] };
        return Stream.concat(Stream.succeed(opening), Stream.fromSubscription(subscription));
      }),
    );
  /** The last fingerprinted state of a PR, if the watcher has read it. */
  const statusFor = (key: PullRequestKey, accountId: AccountId) =>
    Effect.sync(() => statuses.get(`${accountId}:${key}`));

  return {
    inbox,
    inboxAccountsOf,
    repositories: repositoryReads.list,
    repositoryPullRequests: repositoryReads.pulls,
    observe,
    watch,
    presence,
    statusFor,
    refresh: (key: PullRequestKey, accountId: AccountId) =>
      detailReads
        .invalidateStackOf(key, accountId)
        .pipe(Effect.andThen(detailReads.invalidate(key, accountId))),
    ...detailReads,
    invalidate: wrote,
    ...actions,
  };
});

export const layer = Layer.effect(PullRequests, make);
