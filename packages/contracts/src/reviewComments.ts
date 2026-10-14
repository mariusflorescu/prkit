import * as Schema from "effect/Schema";

import { ReviewCommentId } from "./ids.ts";
import { PullRequestAuthor } from "./inbox.ts";
import { FileSide } from "./pullRequest.ts";

/** One line on one side of a diff as GitHub numbers it: `old` is its LEFT side, `new` its RIGHT. */
export const LinePoint = Schema.Struct({
  side: FileSide,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type LinePoint = typeof LinePoint.Type;

/** The lines a comment covers: its first and last diff row, the same row for one line. */
export const CommentAnchor = Schema.Struct({
  path: Schema.String,
  start: LinePoint,
  end: LinePoint,
});
export type CommentAnchor = typeof CommentAnchor.Type;

/** Where a pending comment sits and what it was written on. */
export const CommentPlacement = Schema.Struct({
  anchor: CommentAnchor,
  /** The diff rows it was written on, each `+`, `-` or a space and then the line. */
  snippet: Schema.String,
  /** The head commit of the diff it was written on. */
  commitSha: Schema.String,
});
export type CommentPlacement = typeof CommentPlacement.Type;

/**
 * A draft stays prkit's own until the user finishes the review on GitHub, which
 * publishes it. The agent states are for drafts handed to the user's agent instead.
 */
export const PendingCommentState = Schema.Literals([
  "draft",
  "published",
  "sent-to-agent",
  "resolved-by-agent",
]);
export type PendingCommentState = typeof PendingCommentState.Type;

export const PendingComment = Schema.Struct({
  id: ReviewCommentId,
  ...CommentPlacement.fields,
  body: Schema.String,
  state: PendingCommentState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PendingComment = typeof PendingComment.Type;

/** The comments prkit holds for one PR and account that are not on GitHub yet. */
export const PendingComments = Schema.Struct({ comments: Schema.Array(PendingComment) });
export type PendingComments = typeof PendingComments.Type;

export const ReviewEvent = Schema.Literals(["comment", "approve", "request-changes"]);
export type ReviewEvent = typeof ReviewEvent.Type;

export const ReviewSubmitted = Schema.Struct({
  url: Schema.String,
  posted: Schema.Int,
  /** Drafts left out because their lines changed; they stay drafts. */
  outdated: Schema.Int,
});
export type ReviewSubmitted = typeof ReviewSubmitted.Type;

export class ReviewCommentsError extends Schema.TaggedError<ReviewCommentsError>()(
  "ReviewCommentsError",
  { message: Schema.String },
) {}

export const ReviewThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(PullRequestAuthor),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
  reactions: Schema.Array(Schema.Struct({ emoji: Schema.String, count: Schema.Int })),
});
export type ReviewThreadComment = typeof ReviewThreadComment.Type;

/** A review thread on GitHub, read through the PR's account. */
export const ReviewThread = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  /** Where it sits in the PR's current diff, or null once GitHub marks it outdated. */
  anchor: Schema.NullOr(CommentAnchor),
  /** The line it was written on, which an outdated thread still names. */
  originalLine: Schema.NullOr(Schema.Int),
  /** The hunk it was written on, up to its line, as GitHub kept it. */
  diffHunk: Schema.String,
  resolved: Schema.Boolean,
  canReply: Schema.Boolean,
  /** Whether this account may resolve it, or unresolve it once resolved. */
  canResolve: Schema.Boolean,
  comments: Schema.Array(ReviewThreadComment),
  commentCount: Schema.Int,
});
export type ReviewThread = typeof ReviewThread.Type;

export const ReviewThreads = Schema.Struct({
  /** The PR head GitHub numbered these threads' lines against. */
  headSha: Schema.String,
  threads: Schema.Array(ReviewThread),
  /** More threads exist than prkit reads. */
  truncated: Schema.Boolean,
});
export type ReviewThreads = typeof ReviewThreads.Type;
