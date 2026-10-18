import * as Schema from "effect/Schema";

import { Freshness } from "./github.ts";
import { AccountId, PullRequestKey } from "./ids.ts";
import { InboxEntry, PullRequestAuthor, PullRequestRef } from "./inbox.ts";
import { PullRequestActionInfo } from "./pullRequestActions.ts";
import { StackMembership } from "./stack.ts";

export const PullRequestCheck = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["passing", "failing", "pending", "neutral"]),
  url: Schema.NullOr(Schema.String),
  /** GitHub's short account of the result, cut to a few hundred characters; null when it gave none. */
  summary: Schema.NullOr(Schema.String),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;
export const PullRequestConversation = Schema.Struct({
  id: Schema.String,
  /** `review-comment` is one comment of a review thread on a diff line. */
  kind: Schema.Literals(["comment", "review", "review-comment"]),
  author: Schema.NullOr(PullRequestAuthor),
  at: Schema.String,
  body: Schema.String,
  state: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export const PullRequestDetail = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  ref: PullRequestRef,
  title: Schema.String,
  body: Schema.String,
  state: InboxEntry.fields.state,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(PullRequestAuthor),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  headSha: Schema.String,
  baseSha: Schema.String,
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  reviewDecision: InboxEntry.fields.reviewDecision,
  reviewers: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      avatarUrl: Schema.NullOr(Schema.String),
      requested: Schema.Boolean,
      state: Schema.NullOr(Schema.String),
    }),
  ),
  checks: Schema.Array(PullRequestCheck),
  labels: InboxEntry.fields.labels,
  conversation: Schema.Array(PullRequestConversation),
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  url: Schema.String,
  actions: PullRequestActionInfo,
  stack: Schema.NullOr(StackMembership),
  freshness: Freshness,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;
export class PullRequestReadError extends Schema.TaggedError<PullRequestReadError>()(
  "PullRequestReadError",
  {
    key: PullRequestKey,
    accountId: AccountId,
    reason: Schema.Literals(["not-found", "account", "github", "changed", "contents"]),
    message: Schema.String,
  },
) {}
export const PullRequestFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
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
  patch: Schema.Union([
    Schema.TaggedStruct("text", { patch: Schema.String }),
    Schema.TaggedStruct("binary", {}),
    Schema.TaggedStruct("too-large", { lines: Schema.Int }),
  ]),
});
export const PullRequestFiles = Schema.Struct({
  headSha: Schema.String,
  baseSha: Schema.String,
  changedFiles: Schema.Int,
  files: Schema.Array(PullRequestFile),
});
export type PullRequestFiles = typeof PullRequestFiles.Type;
export const FileSide = Schema.Literals(["old", "new"]);
export type FileSide = typeof FileSide.Type;
export const FileContents = Schema.Struct({ content: Schema.String, sha: Schema.String });
export type FileContents = typeof FileContents.Type;
