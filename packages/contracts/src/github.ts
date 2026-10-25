import * as Schema from "effect/Schema";

import { AccountId, PullRequestKey } from "./ids.ts";

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);

/** GitHub counts REST requests (`core`) and GraphQL points (`graphql`) separately. */
export const GitHubResource = Schema.Literals(["core", "graphql"]);
export type GitHubResource = typeof GitHubResource.Type;

/** One account's limit for one resource, as GitHub's last response headers reported it. */
export const GitHubLimit = Schema.Struct({
  resource: GitHubResource,
  limit: Schema.Int,
  remaining: Schema.Int,
  resetAt: Schema.String,
  /** Set while GitHub refuses this account's requests; prkit sends nothing until then. */
  pausedUntil: Schema.NullOr(Schema.String),
  /** REST requests or GraphQL points this prkit spent in the last hour. */
  spentLastHour: Schema.Int,
});
export type GitHubLimit = typeof GitHubLimit.Type;

export const GitHubBudget = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({ accountId: AccountId, limits: Schema.Array(GitHubLimit) }),
  ),
});
export type GitHubBudget = typeof GitHubBudget.Type;

/** Why prkit answered from its cache instead of reading GitHub. */
export const GitHubProblem = Schema.Union([
  /** The account's limit is used up until `resetAt`. */
  Schema.TaggedStruct("rate-limited", { message: Schema.String, resetAt: Schema.String }),
  /** Background reads wait until `resetAt` so the last 10% stays for clicks. */
  Schema.TaggedStruct("reserved", { message: Schema.String, resetAt: Schema.String }),
  /** GitHub couldn't be reached or answered with an error. */
  Schema.TaggedStruct("unavailable", { message: Schema.String }),
  /** The account's token was refused or the account isn't ready. */
  Schema.TaggedStruct("account", { message: Schema.String }),
]);
export type GitHubProblem = typeof GitHubProblem.Type;

/** When a cached answer was read from GitHub, and why it wasn't read again if it should have been. */
export const Freshness = Schema.Struct({
  fetchedAt: Schema.String,
  problem: Schema.NullOr(GitHubProblem),
});
export type Freshness = typeof Freshness.Type;

/** What an open PR tab shows without reading the PR, from the watcher's fingerprint. */
export const PullRequestStatus = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  title: Schema.String,
  state: PullRequestState,
  isDraft: Schema.Boolean,
});
export type PullRequestStatus = typeof PullRequestStatus.Type;

/** The gh config directory an account is read through. */
export const AccountBinding = Schema.Struct({ accountId: AccountId, configDir: Schema.String });
export type AccountBinding = typeof AccountBinding.Type;

/** What changed on the server's GitHub caches, for a visible window. */
export const GitHubEvent = Schema.Union([
  /**
   * First event of every subscription: the directory each account is read through, null before
   * the first discovery, and the last status of each fingerprinted PR read through its account's.
   */
  Schema.TaggedStruct("opened", {
    bindings: Schema.NullOr(Schema.Array(AccountBinding)),
    statuses: Schema.Array(PullRequestStatus),
  }),
  /**
   * A discovery changed the directory an account is read through, or added or removed one: what a
   * window read through a directory its account left is stale, and these statuses replace its own.
   */
  Schema.TaggedStruct("accounts", {
    bindings: Schema.Array(AccountBinding),
    statuses: Schema.Array(PullRequestStatus),
  }),
  /** This PR's cached reads are stale; refetch what is on screen. `status` is its status now, if any. */
  Schema.TaggedStruct("changed", {
    key: PullRequestKey,
    accountId: AccountId,
    status: Schema.NullOr(PullRequestStatus),
  }),
  /** The inbox cache has a new answer or a new problem. */
  Schema.TaggedStruct("inbox", {}),
  /** A stack's cached layers are stale or have a new answer; refetch the stacks on screen. */
  Schema.TaggedStruct("stack", { accountId: AccountId }),
  /** The repository list, or a repository's open pull requests, has a new answer or problem. */
  Schema.TaggedStruct("repositories", {}),
]);
export type GitHubEvent = typeof GitHubEvent.Type;
