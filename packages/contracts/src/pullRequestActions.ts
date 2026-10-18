import * as Schema from "effect/Schema";

import { AccountId, PullRequestKey } from "./ids.ts";

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;
export const PullRequestActionPreferences = Schema.Struct({
  mergeMethod: Schema.NullOr(PullRequestMergeMethod),
  deleteBranch: Schema.Boolean,
});
const MergeMessage = Schema.Struct({ title: Schema.String, body: Schema.String });
export const PullRequestActionInfo = Schema.Struct({
  nodeId: Schema.String,
  mergeState: Schema.String,
  behindBy: Schema.NullOr(Schema.Int),
  mergeCapabilities: Schema.Struct({
    merge: Schema.Boolean,
    squash: Schema.Boolean,
    rebase: Schema.Boolean,
  }),
  preferredMergeMethod: PullRequestMergeMethod,
  viewerPermissions: Schema.Struct({
    update: Schema.Boolean,
    merge: Schema.Boolean,
    triage: Schema.Boolean,
    updateBranch: Schema.Boolean,
    close: Schema.Boolean,
    reopen: Schema.Boolean,
    labels: Schema.Boolean,
    reviewers: Schema.Boolean,
    enableAutoMerge: Schema.Boolean,
    disableAutoMerge: Schema.Boolean,
  }),
  checksState: Schema.NullOr(Schema.Literals(["passing", "failing", "pending"])),
  autoMergeAllowed: Schema.Boolean,
  autoMergeMethod: Schema.NullOr(PullRequestMergeMethod),
  mergeQueue: Schema.Boolean,
  isFork: Schema.Boolean,
  canDeleteBranch: Schema.Boolean,
  mergeMessages: Schema.Struct({ merge: MergeMessage, squash: MergeMessage }),
  preferences: PullRequestActionPreferences,
});
export type PullRequestActionInfo = typeof PullRequestActionInfo.Type;
export const PullRequestCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["ready", "draft", "close", "reopen", "disable-auto-merge", "revert"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    method: PullRequestMergeMethod,
    expectedHeadSha: Schema.NonEmptyString,
    title: Schema.NonEmptyString,
    body: Schema.String,
    deleteBranch: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("enable-auto-merge"), method: PullRequestMergeMethod }),
  Schema.Struct({
    kind: Schema.Literal("update-branch"),
    method: Schema.Literals(["merge", "rebase"]),
    expectedHeadSha: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("approve-workflows"),
    expectedHeadSha: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    /** Left out, the title stays as it is. */
    title: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
    body: Schema.String,
    /** The description the edit was written against: GitHub's must still be it. */
    expectedBody: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("labels"), labels: Schema.Array(Schema.NonEmptyString) }),
  Schema.Struct({
    kind: Schema.Literal("reviewers"),
    reviewers: Schema.Array(Schema.NonEmptyString),
    teams: Schema.Array(Schema.NonEmptyString),
    requested: Schema.Boolean,
  }),
]);
export type PullRequestCommand = typeof PullRequestCommand.Type;
export const PullRequestActionResult = Schema.Struct({
  message: Schema.String,
  url: Schema.NullOr(Schema.String),
  warning: Schema.NullOr(Schema.String),
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;
export const PullRequestCandidates = Schema.Struct({
  reviewers: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      name: Schema.NullOr(Schema.String),
      avatarUrl: Schema.NullOr(Schema.String),
    }),
  ),
  teams: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
});
export type PullRequestCandidates = typeof PullRequestCandidates.Type;
export class PullRequestActionError extends Schema.TaggedError<PullRequestActionError>()(
  "PullRequestActionError",
  {
    key: PullRequestKey,
    accountId: AccountId,
    reason: Schema.Literals([
      "not-permitted",
      "conflict",
      "checks-required",
      "rate-limited",
      "network",
    ]),
    message: Schema.String,
  },
) {}
