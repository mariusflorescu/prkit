import {
  type Account,
  type AccountBinding,
  type AccountId,
  type AccountsResult,
  type ConfigDirProblem,
  type GitHubEvent,
  type GitHubProblem,
  InboxError,
  InboxLeftOut,
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
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { isoAt } from "../github/budget.ts";
import { GitHubApi, queryFailure } from "../github/GitHubApi.ts";
import { makeActions } from "./actions.ts";
import { FRESH_MS, makeDetailReads } from "./detailReads.ts";
import { PullRequestFingerprint, stackShape, statusOf } from "./fingerprint.ts";
import { accountEntries, CachedInboxEntry, mergeAccounts, SEARCH_NODES } from "./inboxEntries.ts";
import { InboxResponse, inboxQuery, isNodeError } from "./inboxQuery.ts";
import {
  type CacheKey,
  makeObservedReadCache,
  type Observation,
  type ObservedRead,
  type ReadOutcome,
  readProblem,
} from "./readCache.ts";
import { withDeadline } from "./readDeadline.ts";
import { makeRepositoryReads } from "./repositoryReads.ts";
import { makeReviewWaits, WaitsByNode, withWaits } from "./reviewWaits.ts";

/** An account's inbox and the facts behind its review waits, read together so they describe one moment. */
const AccountInbox = Schema.Struct({
  entries: Schema.Array(CachedInboxEntry),
  truncated: InboxResult.fields.truncated,
  leftOut: Schema.Array(InboxLeftOut).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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

/** A tab status and the gh config directory the watcher read it through. */
interface ReadStatus {
  readonly status: PullRequestStatus;
  readonly configDir: string | null;
}

/** The directory each account is read through; null before the first discovery. */
const bindingsOf = (known: AccountsResult | null): ReadonlyArray<AccountBinding> | null =>
  known?.accounts.map(({ id, configDir }) => ({ accountId: id, configDir })) ?? null;
const sameBindings = (
  before: ReadonlyArray<AccountBinding> | null,
  after: ReadonlyArray<AccountBinding>,
) =>
  before?.length === after.length &&
  before.every(
    (binding, index) =>
      binding.accountId === after[index]?.accountId &&
      binding.configDir === after[index]?.configDir,
  );
/** Only a status read through the directory its account is read through now is sent or used. */
const readable = (
  read: ReadStatus | undefined,
  bindings: ReadonlyArray<AccountBinding> | null,
): read is ReadStatus =>
  read !== undefined &&
  bindings !== null &&
  bindings.some(
    (binding) =>
      binding.accountId === read.status.accountId && binding.configDir === read.configDir,
  );

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
  const statuses = new Map<string, ReadStatus>();
  /**
   * Statuses are announced, and a window's stream opens with its snapshot, one at a time, so no
   * window hears a status older than its snapshot or read through a directory a later `accounts`
   * event told it the account left.
   */
  const announcing = yield* Semaphore.make(1);
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
  const readableStatuses = (bindings: ReadonlyArray<AccountBinding> | null) =>
    [...statuses.values()].filter((read) => readable(read, bindings)).map((read) => read.status);
  const statusNow = (key: PullRequestKey, accountId: AccountId) =>
    accounts.known.pipe(
      Effect.map((known) => {
        const read = statuses.get(`${accountId}:${key}`);
        return readable(read, bindingsOf(known)) ? read.status : null;
      }),
    );
  const changed = (key: PullRequestKey, accountId: AccountId) =>
    announcing.withPermits(1)(
      statusNow(key, accountId).pipe(
        Effect.flatMap((status) =>
          PubSub.publish(events, { _tag: "changed", key, accountId, status }),
        ),
      ),
    );
  const detailReads = yield* makeDetailReads({
    changed,
    stackChanged: (accountId) => publish({ _tag: "stack", accountId }),
  });
  /** The bindings the last `accounts` event carried. */
  let told: ReadonlyArray<AccountBinding> | null = null;
  yield* accounts.changes.pipe(
    Stream.runForEach(() =>
      announcing.withPermits(1)(
        Effect.gen(function* () {
          const bindings = bindingsOf(yield* accounts.known);
          if (bindings === null || sameBindings(told, bindings)) return;
          told = bindings;
          yield* PubSub.publish(events, {
            _tag: "accounts",
            bindings,
            statuses: readableStatuses(bindings),
          });
        }),
      ),
    ),
    Effect.forkScoped,
  );
  const inboxCache = yield* makeObservedReadCache({
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
  const inboxKey = (account: Pick<Account, "id" | "configDir">): CacheKey => ({
    accountId: account.id,
    configDir: account.configDir,
    key: "",
  });
  /** The inbox, then the waits of its review requests: one value, so a rule never sees facts from another moment. */
  const fetchAccount = (account: Account) =>
    Effect.gen(function* () {
      const { problems, ...found } = yield* api
        .graphqlResult(account.id, inboxQuery, {}, InboxResponse)
        .pipe(
          Effect.flatMap(({ data, errors }) =>
            data === null ||
            errors.some((error) => !SEARCH_NODES.some((at) => isNodeError(error, at)))
              ? Effect.fail(queryFailure(account.id, errors))
              : Effect.succeed(accountEntries(account, data, errors)),
          ),
          withDeadline(account.id, INBOX_DEADLINE),
        );
      for (const problem of problems)
        yield* Effect.logWarning("Left out a pull request prkit can't read").pipe(
          Effect.annotateLogs({ accountId: account.id, ...problem }),
        );
      for (const item of found.leftOut)
        if (item.message !== null)
          yield* Effect.logWarning("GitHub refused a pull request in the inbox").pipe(
            Effect.annotateLogs({ accountId: account.id, message: item.message }),
          );
      const previous = (yield* inboxCache.peek(inboxKey(account)))?.value.waits ?? {};
      const waits = yield* reviewWaits.read(account, found.entries, previous);
      return { _tag: "read", value: { ...found, waits } } satisfies ReadOutcome<AccountInbox>;
    }).pipe(
      Effect.catchTag("GitHubRequestError", (error) =>
        Effect.succeed({
          _tag: "failed",
          problem: readProblem(error),
        } satisfies ReadOutcome<AccountInbox>),
      ),
    );
  const row = (
    accountId: AccountId,
    kept: Observation<AccountInbox>["kept"],
    problem: GitHubProblem | null,
  ) => ({
    accountId,
    inbox: {
      entries: withWaits(accountId, kept?.value.entries ?? [], kept?.value.waits ?? {}),
      truncated: kept?.value.truncated ?? [],
      leftOut: kept?.value.leftOut ?? [],
    },
    fetchedAt: kept === undefined ? null : isoAt(kept.fetchedAt),
    problem,
  });
  const accountRow = (account: Pick<Account, "id" | "status">, seen: Observation<AccountInbox>) =>
    row(
      account.id,
      seen.kept,
      account.status._tag === "error"
        ? { _tag: "account", message: account.status.message }
        : seen.problem,
    );
  /** One account's inbox as kept; an account prkit can't read is never read, only shown. */
  const readAccount = (account: Account, mode: ObservedRead) =>
    (account.status._tag === "error"
      ? inboxCache.observe(inboxKey(account))
      : inboxCache.read(inboxKey(account), fetchAccount(account), mode)
    ).pipe(Effect.map((seen) => accountRow(account, seen)));
  const modeOf = (read: InboxRead, account: Account): ObservedRead =>
    read._tag === "refresh" || (read._tag === "retry" && read.accountId === account.id)
      ? "refresh"
      : read._tag === "cached"
        ? "cached"
        : "snapshot";
  const result = (
    rows: ReadonlyArray<ReturnType<typeof row>>,
    configDirProblems: ReadonlyArray<ConfigDirProblem>,
  ): InboxResult => {
    const entries = mergeAccounts(rows.flatMap((item) => item.inbox.entries));
    return {
      entries,
      leftOut: rows.flatMap((item) => item.inbox.leftOut),
      accounts: rows.map((item) => ({
        accountId: item.accountId,
        count: item.inbox.entries.length,
        fetchedAt: item.fetchedAt,
        problem: item.problem,
      })),
      truncated: rows.flatMap((item) => item.inbox.truncated),
      configDirProblems,
    };
  };
  const readAll = (read: InboxRead) =>
    Effect.gen(function* () {
      const discovered = yield* accounts.list();
      const rows = yield* Effect.forEach(
        discovered.accounts,
        (account) => readAccount(account, modeOf(read, account)),
        { concurrency: 4 },
      );
      if (read._tag === "snapshot") return result(rows, discovered.configDirProblems);
      // What the reads it waited for brought, and every other account as it is by then, each
      // through the directory it is read through by then.
      const now = yield* accounts.list();
      const settled = yield* Effect.forEach(now.accounts, (account) =>
        inboxCache.observe(inboxKey(account)).pipe(Effect.map((seen) => accountRow(account, seen))),
      );
      return result(settled, now.configDirProblems);
    });
  /**
   * The inbox across accounts. A snapshot never waits for GitHub: before accounts are
   * discovered (a relaunch), it answers with each account the gh config directories list and
   * what was kept of its inbox from that directory, then discovers and tells windows to read
   * again.
   */
  const inbox = (read: InboxRead): Effect.Effect<InboxResult, InboxError> =>
    Effect.gen(function* () {
      if (read._tag === "snapshot" && (yield* accounts.known) === null) {
        const configured = yield* accounts.configured;
        const rows = yield* Effect.forEach(configured.accounts, (account) =>
          inboxCache
            .observe(inboxKey(account))
            .pipe(Effect.map((seen) => accountRow(account, seen))),
        );
        yield* Effect.forkIn(
          readAll(read).pipe(
            Effect.andThen(publish({ _tag: "inbox" })),
            Effect.catchCause((cause) => Effect.logWarning("Inbox catch-up failed", cause)),
          ),
          scope,
        );
        return result(rows, configured.configDirProblems);
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
    configDir: string | null,
    fingerprint: PullRequestFingerprint,
  ) =>
    Effect.gen(function* () {
      const id = `${accountId}:${key}`;
      const text = encodeFingerprint(fingerprint);
      const previous = fingerprints.get(id);
      const known = statuses.get(id);
      statuses.set(id, { status: statusOf(key, accountId, fingerprint), configDir });
      if (previous === text) {
        if (known?.configDir !== configDir) yield* changed(key, accountId);
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
          yield* changed(key, accountId);
          return;
        }
      }
      yield* Effect.logInfo("Pull request changed on GitHub").pipe(
        Effect.annotateLogs({ key, accountId }),
      );
      yield* detailReads.invalidate(key, accountId);
    });

  /** Open while a window is visible: first the known statuses, then every change. */
  const watch = (): Stream.Stream<GitHubEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { subscription, opening } = yield* announcing.withPermits(1)(
          Effect.gen(function* () {
            const bindings = bindingsOf(yield* accounts.known);
            const opening: GitHubEvent = {
              _tag: "opened",
              bindings,
              statuses: readableStatuses(bindings),
            };
            return { subscription: yield* PubSub.subscribe(events), opening };
          }),
        );
        yield* Effect.acquireRelease(
          SubscriptionRef.update(presence, (count) => count + 1),
          () => SubscriptionRef.update(presence, (count) => count - 1),
        );
        return Stream.concat(Stream.succeed(opening), Stream.fromSubscription(subscription));
      }),
    );
  /** The last fingerprinted state of a PR, if the watcher read it through its account's directory. */
  const statusFor = (key: PullRequestKey, accountId: AccountId) =>
    statusNow(key, accountId).pipe(Effect.map((status) => status ?? undefined));

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
