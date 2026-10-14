import * as Schema from "effect/Schema";

import { Freshness, GitHubProblem } from "./github.ts";
import { AccountId } from "./ids.ts";
import { PullRequestSummary } from "./inbox.ts";

/** A repository by its name on one host, and every account that can see it. */
export const Repository = Schema.Struct({
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  isPrivate: Schema.Boolean,
  /** The first one reads it; ordered by account id. */
  accountIds: Schema.NonEmptyArray(AccountId),
});
export type Repository = typeof Repository.Type;

/** Every repository the accounts can see, with how old each account's list is. */
export const RepositoryList = Schema.Struct({
  repositories: Schema.Array(Repository),
  accounts: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      count: Schema.Int,
      fetchedAt: Schema.NullOr(Schema.String),
      problem: Schema.NullOr(GitHubProblem),
      /** GitHub's count when prkit stopped reading pages before the end; null when it read all. */
      total: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type RepositoryList = typeof RepositoryList.Type;

/** `cached` answers from prkit's cache, kept a day; `refresh` reads every account now. */
export const RepositoryListRead = Schema.Union([
  Schema.TaggedStruct("cached", {}),
  Schema.TaggedStruct("refresh", {}),
]);
export type RepositoryListRead = typeof RepositoryListRead.Type;

/** A repository's open pull requests, newest first, read through one account. */
export const RepositoryPullRequests = Schema.Struct({
  entries: Schema.Array(PullRequestSummary),
  /** How many are open; more than `entries` when there are more than prkit reads. */
  total: Schema.Int,
  freshness: Freshness,
});
export type RepositoryPullRequests = typeof RepositoryPullRequests.Type;

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  message: Schema.String,
}) {}
