import {
  type AccountId,
  type Freshness,
  FileContents,
  type FileSide,
  InboxEntry,
  type PullRequestCheck,
  PullRequestDetail,
  PullRequestFiles,
  PullRequestTimeline,
  PullRequestReadError,
  ReviewCommentsError,
  ReviewThreads,
  PullRequestKey,
  type PullRequestRef,
  PullRequestStack,
  type PullRequestStatus,
  refFromKey,
} from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { GitHubApi, GitHubRequestError } from "../github/GitHubApi.ts";
import { makeReviewThreads } from "./reviewThreads.ts";
import { makeTimelineRead } from "./timelineRead.ts";
import { makeActionReads } from "./actionReads.ts";
import { isoAt } from "../github/budget.ts";
import { type Cached, makeReadCache } from "./readCache.ts";
import { RestStack, restMembership, STACK_QUERY, StackResponse, stackOf } from "./stackQuery.ts";

const User = Schema.Struct({ login: Schema.String, avatar_url: Schema.String });
const Branch = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const Pull = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  user: Schema.NullOr(User),
  head: Branch,
  base: Branch,
  requested_reviewers: Schema.Array(User),
  requested_teams: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
  labels: InboxEntry.fields.labels,
  additions: Schema.Int,
  deletions: Schema.Int,
  changed_files: Schema.Int,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  stack: RestStack,
});
const Comment = Schema.Struct({
  id: Schema.Int,
  user: Schema.NullOr(User),
  body: Schema.String,
  created_at: Schema.String,
  html_url: Schema.String,
});
const Review = Schema.Struct({
  id: Schema.Int,
  user: Schema.NullOr(User),
  body: Schema.String,
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  html_url: Schema.String,
});
export const CheckRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
});
export const Status = Schema.Struct({
  id: Schema.Int,
  context: Schema.String,
  state: Schema.String,
  target_url: Schema.NullOr(Schema.String),
});
const RawFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optionalKey(Schema.String),
  status: Schema.Literals([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  additions: Schema.Int,
  deletions: Schema.Int,
  patch: Schema.optionalKey(Schema.String),
});
const toAuthor = (user: typeof User.Type | null) =>
  user === null ? null : { login: user.login, avatarUrl: user.avatar_url };
const checkStatus = (status: string, conclusion: string | null) => {
  if (status !== "completed") return "pending" as const;
  if (conclusion === "success") return "passing" as const;
  if (conclusion === "neutral" || conclusion === "skipped") return "neutral" as const;
  return "failing" as const;
};

/** The checks a detail shows for a commit's check runs. */
export const shownCheckRuns = (
  runs: ReadonlyArray<typeof CheckRun.Type>,
): Array<PullRequestCheck> =>
  runs.map((check) => ({
    id: `check-${check.id}`,
    name: check.name,
    status: checkStatus(check.status, check.conclusion),
    url: check.html_url,
  }));
/** The checks a detail shows for a commit's statuses: the newest one of each context. */
export const shownStatuses = (
  statuses: ReadonlyArray<typeof Status.Type>,
): Array<PullRequestCheck> => {
  const latest = new Map<string, typeof Status.Type>();
  for (const status of statuses)
    if (!latest.has(status.context)) latest.set(status.context, status);
  return [...latest.values()].map((status) => ({
    id: `status-${status.id}`,
    name: status.context,
    status:
      status.state === "success" ? "passing" : status.state === "pending" ? "pending" : "failing",
    url: status.target_url,
  }));
};

const isGitHubError = Schema.is(GitHubRequestError);

/** The owner's ten minutes: within them a read is answered from cache without GitHub. */
export const FRESH_MS = 10 * 60_000;

const freshnessOf = <V>(cached: Cached<V>): Freshness => ({
  fetchedAt: isoAt(cached.fetchedAt),
  problem: cached.problem,
});

interface DetailReadsOptions {
  /** A cached read of this PR has a new answer or a new problem. */
  readonly changed: (
    key: PullRequestKey,
    accountId: AccountId,
    status: PullRequestStatus | null,
  ) => Effect.Effect<void>;
  /** A cached stack read through this account has a new answer or a new problem. */
  readonly stackChanged: (accountId: AccountId) => Effect.Effect<void>;
}

/** One cache entry per stack, so every layer reads the same answer. */
const stackKey = (ref: PullRequestRef, stack: number) =>
  `${ref.host}/${ref.owner}/${ref.repo}/stacks/${stack}`;

export const makeDetailReads = Effect.fnUntraced(function* (options: DetailReadsOptions) {
  const api = yield* GitHubApi;
  const accounts = yield* GitHubAccounts;
  const readTimeline = yield* makeTimelineRead;
  const actionReads = yield* makeActionReads;
  const reviewThreads = yield* makeReviewThreads;
  const changed = (cacheKey: { readonly accountId: AccountId; readonly key: string }) =>
    options.changed(PullRequestKey.make(cacheKey.key), cacheKey.accountId, null);
  const threadsCache = yield* makeReadCache({
    name: "review-threads",
    json: Schema.fromJsonString(ReviewThreads),
    maxEntries: 64,
    maxBytes: 16 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed,
  });
  const timelineCache = yield* makeReadCache({
    name: "timeline",
    json: Schema.fromJsonString(PullRequestTimeline),
    maxEntries: 64,
    maxBytes: 8 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed,
  });
  const detailCache = yield* makeReadCache({
    name: "detail",
    json: Schema.fromJsonString(PullRequestDetail),
    maxEntries: 64,
    maxBytes: 16 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed,
  });
  // Keyed by commit, so an answer never goes stale.
  const contentsCache = yield* makeReadCache({
    name: "contents",
    json: Schema.fromJsonString(FileContents),
    maxEntries: 128,
    maxBytes: 16 * 1024 * 1024,
    freshMs: Number.POSITIVE_INFINITY,
    persist: false,
    changed: () => Effect.void,
  });
  const filesCache = yield* makeReadCache({
    name: "files",
    json: Schema.fromJsonString(PullRequestFiles),
    maxEntries: 32,
    maxBytes: 32 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed,
  });
  const stackCache = yield* makeReadCache({
    name: "stack",
    json: Schema.fromJsonString(Schema.NullOr(PullRequestStack)),
    maxEntries: 64,
    maxBytes: 2 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed: (cacheKey) => options.stackChanged(cacheKey.accountId),
  });
  const MergeBase = Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Schema.String }) });
  const mergeBases = yield* makeReadCache({
    name: "merge-base",
    json: Schema.fromJsonString(MergeBase),
    maxEntries: 256,
    maxBytes: 128 * 1024,
    freshMs: 24 * 60 * 60_000,
    persist: false,
    changed: () => Effect.void,
  });
  const fail = (
    key: PullRequestKey,
    accountId: AccountId,
    reason: PullRequestReadError["reason"],
    message: string,
  ) => new PullRequestReadError({ key, accountId, reason, message });
  const binding = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      const list = yield* accounts
        .list()
        .pipe(Effect.mapError((error) => fail(key, accountId, "account", error.message)));
      const account = list.accounts.find((row) => row.id === accountId);
      if (!account || account.status._tag !== "ready")
        return yield* fail(
          key,
          accountId,
          "account",
          `Account ${accountId} isn't ready. Refresh Accounts in Settings and retry.`,
        );
      if (!ref || account.host !== ref.host)
        return yield* fail(
          key,
          accountId,
          "account",
          `Account ${accountId} can't read pull requests on this host.`,
        );
      return {
        ref,
        account,
        root: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
        pullPath: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`,
      };
    });
  const readError =
    (key: PullRequestKey, accountId: AccountId) =>
    <A, R>(self: Effect.Effect<A, PullRequestReadError | GitHubRequestError, R>) =>
      self.pipe(
        Effect.catchTag("GitHubRequestError", (error) =>
          Effect.fail(
            fail(
              key,
              accountId,
              error.status === 404 || error.status === 403
                ? "not-found"
                : error.status === 401
                  ? "account"
                  : "github",
              error.status === 404 || error.status === 403
                ? `This pull request wasn't found or you have no access through account ${accountId}. Check its repository access in Settings, then retry.`
                : error.message,
            ),
          ),
        ),
      );
  const pages = <A>(
    accountId: AccountId,
    path: string,
    schema: Schema.ConstraintDecoder<A>,
    allowTruncation = false,
  ) =>
    Effect.gen(function* () {
      const result: A[] = [];
      for (let page = 1; ; page++) {
        const rows = yield* api.rest(
          accountId,
          `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
          Schema.Array(schema),
        );
        result.push(...rows);
        if (rows.length < 100) return result;
        if (page === 30) {
          yield* Effect.logWarning("GitHub pagination reached its limit").pipe(
            Effect.annotateLogs({ accountId, path, maxPages: 30 }),
          );
          if (allowTruncation) return result;
          return yield* new GitHubRequestError({
            accountId,
            reason: "rejected",
            status: null,
            message:
              "This pull request has too many comments, reviews, or statuses to load safely. Open it on GitHub.",
          });
        }
      }
    });
  /** A fetch past every cache, with its own deadline, for the caches below. */
  const deadline =
    (key: PullRequestKey, accountId: AccountId, what: string, message: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.timeoutOrElse({
          duration: "40 seconds",
          orElse: () =>
            Effect.logWarning(`${what} reached its deadline`).pipe(
              Effect.annotateLogs({ accountId, key, timeoutMs: 40_000 }),
              Effect.andThen(
                Effect.fail(
                  new GitHubRequestError({ accountId, reason: "network", status: null, message }),
                ),
              ),
            ),
        }),
      );
  const cacheKey = (
    key: PullRequestKey,
    account: { readonly id: AccountId; readonly configDir: string },
  ) => ({
    accountId: account.id,
    configDir: account.configDir,
    key,
  });
  const fetchDetail = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { ref, root, pullPath } = yield* binding(key, accountId);
      const pull = yield* api.rest(accountId, pullPath, Pull);
      const [comments, inlineComments, reviews, statuses, checkRuns, decision] = yield* Effect.all(
        [
          pages(accountId, `${root}/issues/${ref.number}/comments`, Comment),
          pages(accountId, `${pullPath}/comments`, Comment),
          pages(accountId, `${pullPath}/reviews`, Review),
          pages(accountId, `${root}/commits/${pull.head.sha}/statuses`, Status),
          Effect.gen(function* () {
            const rows: (typeof CheckRun.Type)[] = [];
            for (let page = 1; ; page++) {
              const response = yield* api.rest(
                accountId,
                `${root}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
                Schema.Struct({ check_runs: Schema.Array(CheckRun) }),
              );
              rows.push(...response.check_runs);
              if (response.check_runs.length < 100) return rows;
              if (page === 30) {
                yield* Effect.logWarning("GitHub check-run pagination reached its limit").pipe(
                  Effect.annotateLogs({ accountId, key, maxPages: 30 }),
                );
                return yield* new GitHubRequestError({
                  accountId,
                  reason: "rejected",
                  status: null,
                  message:
                    "This pull request has too many checks to load safely. Open it on GitHub.",
                });
              }
            }
          }),
          // A GitHub failure stays one, so a rate limit falls back to the cached detail.
          actionReads
            .read(accountId, ref)
            .pipe(
              Effect.mapError((error) =>
                isGitHubError(error)
                  ? error
                  : fail(
                      key,
                      accountId,
                      "github",
                      "Couldn't read pull request action preferences. Retry.",
                    ),
              ),
            ),
        ],
        { concurrency: 4 },
      );
      const reviewers = new Map<string, PullRequestDetail["reviewers"][number]>(
        pull.requested_reviewers.map((user) => [
          user.login,
          { login: user.login, avatarUrl: user.avatar_url, requested: true, state: null },
        ]),
      );
      for (const review of reviews.toSorted((a, b) =>
        (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""),
      )) {
        if (!review.user || review.state === "PENDING") continue;
        const current = reviewers.get(review.user.login);
        reviewers.set(review.user.login, {
          login: review.user.login,
          avatarUrl: review.user.avatar_url,
          requested: current?.requested ?? false,
          state: review.state,
        });
      }
      const value: PullRequestDetail = {
        key,
        accountId,
        ref,
        title: pull.title,
        body: pull.body ?? "",
        state: pull.merged ? "merged" : pull.state,
        createdAt: pull.created_at,
        updatedAt: pull.updated_at,
        isDraft: pull.draft,
        author: toAuthor(pull.user),
        headBranch: pull.head.ref,
        baseBranch: pull.base.ref,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        mergeability:
          pull.mergeable === null ? "unknown" : pull.mergeable ? "mergeable" : "conflicting",
        reviewDecision: decision.reviewDecision,
        actions: decision.actions,
        reviewers: [
          ...reviewers.values(),
          ...pull.requested_teams.map((team) => ({
            login: team.name,
            avatarUrl: null,
            requested: true,
            state: null,
          })),
        ],
        checks: [...shownCheckRuns(checkRuns), ...shownStatuses(statuses)],
        labels: pull.labels,
        stack: restMembership(pull.stack),
        conversation: [
          ...[
            ...comments.map((comment) => ({ comment, kind: "comment" as const })),
            ...inlineComments.map((comment) => ({ comment, kind: "review-comment" as const })),
          ].map(({ comment, kind }) => ({
            id: `comment-${comment.id}`,
            kind,
            author: toAuthor(comment.user),
            at: comment.created_at,
            body: comment.body,
            state: null,
            url: comment.html_url,
          })),
          ...reviews.flatMap((review) =>
            review.submitted_at && (review.body.trim().length > 0 || review.state !== "COMMENTED")
              ? [
                  {
                    id: `review-${review.id}`,
                    kind: "review" as const,
                    author: toAuthor(review.user),
                    at: review.submitted_at,
                    body: review.body,
                    state: review.state,
                    url: review.html_url,
                  },
                ]
              : [],
          ),
        ].toSorted((a, b) => a.at.localeCompare(b.at)),
        additions: pull.additions,
        deletions: pull.deletions,
        changedFiles: pull.changed_files,
        url: pull.html_url,
        freshness: { fetchedAt: isoAt(yield* Clock.currentTimeMillis), problem: null },
      };
      yield* Effect.logDebug("Pull request detail read").pipe(
        Effect.annotateLogs({ accountId, key, headSha: value.headSha }),
      );
      return value;
    }).pipe(
      deadline(
        key,
        accountId,
        "Pull request detail",
        "GitHub took too long to load this pull request. Retry.",
      ),
    );
  const detail = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { account } = yield* binding(key, accountId);
      const cached = yield* detailCache.read(cacheKey(key, account), fetchDetail(key, accountId));
      return { ...cached.value, freshness: freshnessOf(cached) };
    }).pipe(readError(key, accountId));
  /** The cached detail, without reading GitHub. */
  const cachedDetail = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { account } = yield* binding(key, accountId);
      return yield* detailCache.peek(cacheKey(key, account));
    });
  /** The detail as GitHub has it now; an action never decides on a cached answer. */
  const current = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { account } = yield* binding(key, accountId);
      const cached = yield* detailCache.read(cacheKey(key, account), fetchDetail(key, accountId), {
        refresh: true,
        fallback: false,
      });
      return cached.value;
    });
  const toFiles = (
    pull: typeof Pull.Type,
    all: ReadonlyArray<typeof RawFile.Type>,
  ): PullRequestFiles => ({
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    changedFiles: pull.changed_files,
    files: all.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch:
        file.patch !== undefined
          ? { _tag: "text" as const, patch: file.patch }
          : file.status === "renamed" && file.additions + file.deletions === 0
            ? { _tag: "text" as const, patch: "" }
            : file.additions + file.deletions === 0
              ? { _tag: "binary" as const }
              : { _tag: "too-large" as const, lines: file.additions + file.deletions },
    })),
  });
  /**
   * The files of the head the detail shows. If the PR moves while its pages load,
   * the pages are read once more for the new head and the detail is marked stale.
   */
  const files = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { pullPath, account } = yield* binding(key, accountId);
      const shown = yield* detail(key, accountId);
      const fetch = Effect.gen(function* () {
        let before = { head: shown.headSha, base: shown.baseSha };
        for (let attempt = 0; attempt < 2; attempt++) {
          const all = yield* pages(accountId, `${pullPath}/files`, RawFile, true);
          const after = yield* api.rest(accountId, pullPath, Pull);
          if (before.head === after.head.sha && before.base === after.base.sha) {
            if (attempt > 0) yield* invalidate(key, accountId);
            return toFiles(after, all);
          }
          before = { head: after.head.sha, base: after.base.sha };
        }
        return yield* fail(
          key,
          accountId,
          "changed",
          "This pull request changed while its files loaded. Retry to read the new commit.",
        );
      });
      const cached = yield* filesCache.read(cacheKey(key, account), fetch, {
        accept: (value) => value.headSha === shown.headSha && value.baseSha === shown.baseSha,
      });
      return cached.value;
    }).pipe(readError(key, accountId));
  const mergeBaseOf = (
    key: PullRequestKey,
    accountId: AccountId,
    snapshot: { readonly baseSha: string; readonly headSha: string },
  ) =>
    Effect.gen(function* () {
      const { root, account } = yield* binding(key, accountId);
      const range = `${snapshot.baseSha}...${snapshot.headSha}`;
      const cached = yield* mergeBases.read(
        { accountId, configDir: account.configDir, key: `${root}/compare/${range}` },
        api.rest(accountId, `${root}/compare/${range}`, MergeBase),
      );
      return cached.value.merge_base_commit.sha;
    });
  const fileDiffIdentity = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const snapshot = yield* files(key, accountId);
      return {
        headSha: snapshot.headSha,
        baseSha: snapshot.baseSha,
        mergeBaseSha: yield* mergeBaseOf(key, accountId, snapshot),
      };
    }).pipe(readError(key, accountId));
  const fileContents = (key: PullRequestKey, accountId: AccountId, path: string, side: FileSide) =>
    Effect.gen(function* () {
      const { root, account } = yield* binding(key, accountId);
      const snapshot = yield* files(key, accountId);
      const file = snapshot.files.find((file) => file.path === path);
      if (!file)
        return yield* fail(
          key,
          accountId,
          "contents",
          "This file is no longer in the pull request. Refresh and try again.",
        );
      if (
        (side === "old" && file.status === "added") ||
        (side === "new" && file.status === "removed")
      )
        return { content: "", sha: snapshot.headSha };
      const mergeBase = yield* mergeBaseOf(key, accountId, snapshot);
      const sha = side === "new" ? snapshot.headSha : mergeBase;
      const readPath = side === "old" ? (file.previousPath ?? path) : path;
      const fetch = Effect.gen(function* () {
        const response = yield* api.rest(
          accountId,
          `${root}/contents/${readPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`,
          Schema.Struct({ content: Schema.String, encoding: Schema.String, size: Schema.Int }),
        );
        if (response.encoding !== "base64" || response.size > 1_000_000)
          return yield* fail(
            key,
            accountId,
            "contents",
            "This file is too large to expand through GitHub.",
          );
        const content = yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.from(response.content, "base64"),
            ),
          catch: () =>
            fail(key, accountId, "contents", "This binary file can't be expanded as text."),
        });
        if (content.includes("\0"))
          return yield* fail(
            key,
            accountId,
            "contents",
            "This binary file can't be expanded as text.",
          );
        return { content, sha };
      });
      const cached = yield* contentsCache.read(
        { accountId, configDir: account.configDir, key: `${key}:${sha}:${readPath}` },
        fetch,
      );
      return cached.value;
    }).pipe(readError(key, accountId));
  const timeline = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { account, ref } = yield* binding(key, accountId);
      const cached = yield* timelineCache.read(
        cacheKey(key, account),
        readTimeline(accountId, ref),
      );
      return cached.value;
    }).pipe(readError(key, accountId));
  /**
   * Marks every cached read of this PR stale, so the next read of each goes to
   * GitHub, and tells visible windows to read again what they show.
   */
  const invalidate = (
    key: PullRequestKey,
    accountId: AccountId,
    status: PullRequestStatus | null = null,
  ) =>
    Effect.all(
      [detailCache, timelineCache, threadsCache, filesCache].map((cache) =>
        cache.invalidate(accountId, key),
      ),
      { discard: true },
    ).pipe(Effect.andThen(options.changed(key, accountId, status)));
  /** New check results: only the detail shows them. */
  const checksChanged = (key: PullRequestKey, accountId: AccountId) =>
    detailCache
      .invalidate(accountId, key)
      .pipe(Effect.andThen(options.changed(key, accountId, null)));
  /** Threads as GitHub numbers them against the head the detail shows. */
  const threads = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const { account, ref } = yield* binding(key, accountId);
      const shown = yield* detail(key, accountId);
      const cached = yield* threadsCache.read(
        cacheKey(key, account),
        reviewThreads
          .read(accountId, ref)
          .pipe(
            deadline(
              key,
              accountId,
              "GitHub review thread read",
              "GitHub took too long to load review comments. Try refreshing.",
            ),
          ),
        { accept: (value) => value.headSha === shown.headSha },
      );
      return cached.value;
    }).pipe(readError(key, accountId));
  /**
   * Writes to a thread only through the PR's account and only when the thread is
   * one of this PR's, then answers with the threads as GitHub has them now.
   */
  const changeThread = (
    key: PullRequestKey,
    accountId: AccountId,
    threadId: string,
    change: Effect.Effect<void, GitHubRequestError>,
  ) =>
    Effect.gen(function* () {
      const known = (value: ReviewThreads) => value.threads.some((row) => row.id === threadId);
      if (!known(yield* threads(key, accountId))) {
        yield* invalidate(key, accountId);
        if (!known(yield* threads(key, accountId)))
          return yield* new ReviewCommentsError({
            message: "This thread is no longer on the pull request. Refresh and try again.",
          });
      }
      yield* change;
      yield* invalidate(key, accountId);
      return yield* threads(key, accountId);
    }).pipe(
      Effect.catchTags({
        GitHubRequestError: (error) =>
          Effect.fail(new ReviewCommentsError({ message: error.message })),
        PullRequestReadError: (error) =>
          Effect.fail(new ReviewCommentsError({ message: error.message })),
      }),
    );
  const replyToThread = (
    key: PullRequestKey,
    accountId: AccountId,
    threadId: string,
    body: string,
  ) => changeThread(key, accountId, threadId, reviewThreads.reply(accountId, threadId, body));
  const resolveThread = (
    key: PullRequestKey,
    accountId: AccountId,
    threadId: string,
    resolved: boolean,
  ) =>
    changeThread(
      key,
      accountId,
      threadId,
      reviewThreads.setResolved(accountId, threadId, resolved),
    );
  /**
   * The layers of the stack `stack` that this PR belongs to, through the PR's own
   * account. Every layer shares one cached read; an answer that no longer lists this
   * PR is read again.
   */
  const readStack = (key: PullRequestKey, accountId: AccountId, stack: number) =>
    Effect.gen(function* () {
      const { ref, account } = yield* binding(key, accountId);
      const cached = yield* stackCache.read(
        { accountId, configDir: account.configDir, key: stackKey(ref, stack) },
        api
          .graphql(accountId, STACK_QUERY, StackResponse, {
            owner: ref.owner,
            name: ref.repo,
            number: ref.number,
          })
          .pipe(
            Effect.map(stackOf),
            deadline(
              key,
              accountId,
              "Stack read",
              "GitHub took too long to load this stack. Try refreshing.",
            ),
          ),
        {
          accept: (value) =>
            value !== null &&
            value.number === stack &&
            value.layers.some((layer) => layer.number === ref.number),
        },
      );
      return cached.value;
    }).pipe(readError(key, accountId));
  /** The stack the PR's detail says it is in, or null. */
  const stack = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const shown = yield* detail(key, accountId);
      return shown.stack === null ? null : yield* readStack(key, accountId, shown.stack.number);
    });
  /** Marks a stack's cached layers stale, so the next read goes to GitHub. */
  const invalidateStack = (accountId: AccountId, ref: PullRequestRef, stack: number) =>
    stackCache.invalidate(accountId, stackKey(ref, stack));
  /** The stack this PR's cached detail names, marked stale. */
  const invalidateStackOf = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      const cached = yield* cachedDetail(key, accountId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (ref === null || cached?.value.stack == null) return;
      yield* invalidateStack(accountId, ref, cached.value.stack.number);
      yield* options.stackChanged(accountId);
    });
  return {
    detail,
    cachedDetail,
    stack,
    readStack,
    invalidateStack,
    invalidateStackOf,
    current,
    files,
    fileContents,
    fileDiffIdentity,
    timeline,
    invalidate,
    checksChanged,
    threads,
    replyToThread,
    resolveThread,
  };
});
