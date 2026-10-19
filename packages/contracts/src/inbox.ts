import * as Schema from "effect/Schema";

import { ConfigDirProblem } from "./accounts.ts";
import { GitHubProblem, PullRequestState } from "./github.ts";
import { AccountId, PullRequestKey } from "./ids.ts";
import { ReviewWait } from "./inboxTriage.ts";
import { StackMembership } from "./stack.ts";

export const PullRequestRef = Schema.Struct({
  host: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PullRequestRef = typeof PullRequestRef.Type;
export const pullRequestKey = (ref: PullRequestRef) =>
  PullRequestKey.make(`${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`);

export const InboxReason = Schema.Literals(["review-requested", "authored", "involved"]);
export type InboxReason = typeof InboxReason.Type;
export const PullRequestAuthor = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
/** A repository label; `color` is GitHub's six hex digits without `#`. */
export const PullRequestLabel = Schema.Struct({ name: Schema.String, color: Schema.String });
export type PullRequestLabel = typeof PullRequestLabel.Type;
/** A pull request as a list row shows it, read through `accountId`. */
export const PullRequestSummary = Schema.Struct({
  accountId: AccountId,
  ref: PullRequestRef,
  title: Schema.String,
  url: Schema.String,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(PullRequestAuthor),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
  ),
  checks: Schema.NullOr(Schema.Literals(["passing", "failing", "pending"])),
  labels: Schema.Array(PullRequestLabel),
  stack: Schema.NullOr(StackMembership),
});
export type PullRequestSummary = typeof PullRequestSummary.Type;
/** A pull request that needs you, and why. */
export const InboxEntry = Schema.Struct({
  ...PullRequestSummary.fields,
  reasons: Schema.NonEmptyArray(InboxReason),
  /** Null when the entry isn't a review request. */
  wait: Schema.NullOr(ReviewWait),
});
export type InboxEntry = typeof InboxEntry.Type;
export const inboxReasonPriority = { "review-requested": 0, authored: 1, involved: 2 } as const;
export const primaryInboxReason = (reasons: InboxEntry["reasons"]) =>
  reasons.reduce(
    (best, reason) => (inboxReasonPriority[reason] < inboxReasonPriority[best] ? reason : best),
    reasons[0],
  );
/**
 * A pull request an account's inbox searches found and left out: prkit couldn't read what GitHub
 * sent for it, or GitHub refused it with `message`. `pullRequest` names it when the answer does.
 */
export const InboxLeftOut = Schema.Struct({
  accountId: AccountId,
  pullRequest: Schema.NullOr(Schema.Struct({ ref: PullRequestRef, url: Schema.String })),
  message: Schema.NullOr(Schema.String),
});
export type InboxLeftOut = typeof InboxLeftOut.Type;
export const InboxResult = Schema.Struct({
  entries: Schema.Array(InboxEntry),
  leftOut: Schema.Array(InboxLeftOut),
  /** One row per account: how old its entries are, and why they weren't read again. */
  accounts: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      count: Schema.Int,
      fetchedAt: Schema.NullOr(Schema.String),
      problem: Schema.NullOr(GitHubProblem),
    }),
  ),
  truncated: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      reason: InboxReason,
      shown: Schema.Int,
      total: Schema.Int,
    }),
  ),
  /** gh config directories prkit couldn't read, from the same discovery as `accounts`. */
  configDirProblems: Schema.Array(ConfigDirProblem),
});
export type InboxResult = typeof InboxResult.Type;
/**
 * `snapshot` answers at once with what prkit keeps of every account, and why an account's
 * last read failed; the reads it starts tell windows `inbox` when they land. `cached` waits
 * for an account prkit kept nothing of, or whose answer a write made stale, for callers that
 * hear no `inbox` events. Both answer older than ten minutes from cache and read it again in
 * the background. `refresh` reads every account now; `retry` reads one account now.
 */
export const InboxRead = Schema.Union([
  Schema.TaggedStruct("snapshot", {}),
  Schema.TaggedStruct("cached", {}),
  Schema.TaggedStruct("refresh", {}),
  Schema.TaggedStruct("retry", { accountId: AccountId }),
]);
export type InboxRead = typeof InboxRead.Type;
export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  message: Schema.String,
}) {}
