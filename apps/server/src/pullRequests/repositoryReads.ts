import {
  type Account,
  type AccountId,
  type GitHubProblem,
  PullRequestSummary,
  type Repository,
  RepositoryError,
  type RepositoryList,
  type RepositoryListRead,
  type RepositoryPullRequests,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { isoAt } from "../github/budget.ts";
import { GitHubApi, GitHubRequestError } from "../github/GitHubApi.ts";
import { FRESH_MS } from "./detailReads.ts";
import { summaryOf } from "./inboxEntries.ts";
import { PullRequestNode, pullRequestRowFragment } from "./inboxQuery.ts";
import { type Cached, makeReadCache, readProblem } from "./readCache.ts";

/** Pages of 100 read per account at most, so an account in a huge organization can't drain its budget. */
const PAGES = 10;
/** Repositories come and go rarely; "Refresh list" reads them sooner. */
const LIST_FRESH_MS = 24 * 60 * 60_000;
/** Open pull requests read for one repository, newest first. */
const PULLS = 50;

const REPOSITORIES_QUERY = `query PrkitRepositories($cursor: String) {
  viewer {
    repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: NAME, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { name isPrivate isArchived owner { login } }
    }
  }
}`;
const RepositoriesPage = Schema.Struct({
  viewer: Schema.Struct({
    repositories: Schema.Struct({
      totalCount: Schema.Int,
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      nodes: Schema.Array(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.String,
            isPrivate: Schema.Boolean,
            isArchived: Schema.Boolean,
            owner: Schema.Struct({ login: Schema.String }),
          }),
        ),
      ),
    }),
  }),
});

const repositoryPullsQuery = (
  stacks: boolean,
) => `query PrkitRepositoryPulls($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { ...PullRequestRow }
    }
  }
}
${pullRequestRowFragment(stacks)}`;
const RepositoryPullsResponse = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequests: Schema.Struct({
        totalCount: Schema.Int,
        nodes: Schema.Array(Schema.NullOr(PullRequestNode)),
      }),
    }),
  ),
});

/** One account's repositories; `total` is GitHub's count when the page ceiling cut the list. */
const AccountRepositories = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({ owner: Schema.String, name: Schema.String, isPrivate: Schema.Boolean }),
  ),
  total: Schema.NullOr(Schema.Int),
});
type AccountRepositories = typeof AccountRepositories.Type;
const RepositoryPulls = Schema.Struct({
  entries: Schema.Array(PullRequestSummary),
  total: Schema.Int,
});

const nameKey = (host: string, owner: string, name: string) =>
  `${host}/${owner}/${name}`.toLowerCase();

/**
 * Every repository the accounts can see, for the Inbox's repository filter, and one
 * repository's open pull requests. Both go through the read cache: the list is kept a
 * day per account and read again in the background after that.
 */
export const makeRepositoryReads = Effect.fnUntraced(function* (options: {
  /** A cached list or a repository's pull requests has a new answer or problem. */
  readonly changed: Effect.Effect<void>;
}) {
  const api = yield* GitHubApi;
  const accounts = yield* GitHubAccounts;
  const listCache = yield* makeReadCache({
    name: "repositories",
    json: Schema.fromJsonString(AccountRepositories),
    maxEntries: 16,
    maxBytes: 8 * 1024 * 1024,
    freshMs: LIST_FRESH_MS,
    persist: true,
    changed: () => options.changed,
  });
  const pullsCache = yield* makeReadCache({
    name: "repository-pulls",
    json: Schema.fromJsonString(RepositoryPulls),
    maxEntries: 32,
    maxBytes: 8 * 1024 * 1024,
    freshMs: FRESH_MS,
    persist: true,
    changed: () => options.changed,
  });

  const fetchAccount = (account: Account) =>
    Effect.gen(function* () {
      const repositories: Array<AccountRepositories["repositories"][number]> = [];
      let cursor: string | null = null;
      let total = 0;
      for (let page = 0; page < PAGES; page++) {
        const response: typeof RepositoriesPage.Type = yield* api.graphql(
          account.id,
          REPOSITORIES_QUERY,
          RepositoriesPage,
          cursor === null ? {} : { cursor },
        );
        const connection = response.viewer.repositories;
        total = connection.totalCount;
        for (const node of connection.nodes)
          if (node !== null && !node.isArchived)
            repositories.push({
              owner: node.owner.login,
              name: node.name,
              isPrivate: node.isPrivate,
            });
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        if (cursor === null) break;
      }
      if (cursor !== null)
        yield* Effect.logWarning("GitHub pagination reached its limit").pipe(
          Effect.annotateLogs({ accountId: account.id, maxPages: PAGES, total }),
        );
      return { repositories, total: cursor === null ? null : total };
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            new GitHubRequestError({
              accountId: account.id,
              reason: "network",
              status: null,
              message: "GitHub took too long to list this account's repositories. Try again.",
            }),
          ),
      }),
    );

  const row = (
    account: Account,
    cached: Cached<AccountRepositories> | undefined,
    problem: GitHubProblem | null,
  ) => ({ account, cached, problem });
  /** One account's list: cached, read now, or the last answer with why it couldn't be read. */
  const readAccount = (account: Account, refresh: boolean) => {
    const key = { accountId: account.id, configDir: account.configDir, key: "" };
    if (account.status._tag === "error") {
      const problem = { _tag: "account" as const, message: account.status.message };
      return listCache.peek(key).pipe(Effect.map((cached) => row(account, cached, problem)));
    }
    return listCache.read(key, fetchAccount(account), { refresh }).pipe(
      Effect.map((cached) => row(account, cached, cached.problem)),
      Effect.catchTag("GitHubRequestError", (error) =>
        listCache.peek(key).pipe(Effect.map((cached) => row(account, cached, readProblem(error)))),
      ),
    );
  };

  const list = (read: RepositoryListRead): Effect.Effect<RepositoryList, RepositoryError> =>
    Effect.gen(function* () {
      const discovered = yield* accounts.list();
      const rows = yield* Effect.forEach(
        discovered.accounts,
        (account) => readAccount(account, read._tag === "refresh"),
        { concurrency: 4 },
      );
      const byName = new Map<string, Repository>();
      for (const { account, cached } of rows.toSorted((left, right) =>
        left.account.id.localeCompare(right.account.id),
      ))
        for (const repository of cached?.value.repositories ?? []) {
          const key = nameKey(account.host, repository.owner, repository.name);
          const known = byName.get(key);
          byName.set(
            key,
            known === undefined
              ? { host: account.host, ...repository, accountIds: [account.id] }
              : { ...known, accountIds: [...known.accountIds, account.id] },
          );
        }
      return {
        repositories: [...byName.values()].toSorted(
          (left, right) =>
            left.owner.localeCompare(right.owner, undefined, { sensitivity: "base" }) ||
            left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        ),
        accounts: rows.map(({ account, cached, problem }) => ({
          accountId: account.id,
          count: cached?.value.repositories.length ?? 0,
          fetchedAt: cached === undefined ? null : isoAt(cached.fetchedAt),
          problem,
          total: cached?.value.total ?? null,
        })),
      };
    }).pipe(
      Effect.catchTag("AccountsError", (error) =>
        Effect.fail(new RepositoryError({ message: error.message })),
      ),
    );

  const fetchPulls = (account: Account, owner: string, name: string) =>
    api.graphql(account.id, repositoryPullsQuery, RepositoryPullsResponse, { owner, name }).pipe(
      Effect.flatMap((response) =>
        response.repository === null
          ? Effect.fail(
              new GitHubRequestError({
                accountId: account.id,
                reason: "not-found",
                status: null,
                message: `${owner}/${name} wasn't found, or ${account.id} has no access to it.`,
              }),
            )
          : Effect.succeed({
              entries: response.repository.pullRequests.nodes.flatMap((node) =>
                node === null ? [] : [summaryOf(account, node)],
              ),
              total: response.repository.pullRequests.totalCount,
            }),
      ),
    );

  /** A repository's open pull requests, read through `accountId` and cached ten minutes. */
  const pulls = (
    accountId: AccountId,
    host: string,
    owner: string,
    name: string,
  ): Effect.Effect<RepositoryPullRequests, RepositoryError> =>
    Effect.gen(function* () {
      const discovered = yield* accounts.list();
      const account = discovered.accounts.find((entry) => entry.id === accountId);
      if (account === undefined || account.status._tag !== "ready")
        return yield* new RepositoryError({
          message: `Account ${accountId} isn't ready. Refresh Accounts in Settings and retry.`,
        });
      if (account.host !== host)
        return yield* new RepositoryError({
          message: `Account ${accountId} can't read repositories on ${host}.`,
        });
      const cached = yield* pullsCache.read(
        { accountId, configDir: account.configDir, key: nameKey(host, owner, name) },
        fetchPulls(account, owner, name),
      );
      return {
        ...cached.value,
        freshness: { fetchedAt: isoAt(cached.fetchedAt), problem: cached.problem },
      };
    }).pipe(
      Effect.catchTags({
        AccountsError: (error) => Effect.fail(new RepositoryError({ message: error.message })),
        GitHubRequestError: (error) => Effect.fail(new RepositoryError({ message: error.message })),
      }),
    );

  return { list, pulls };
});
