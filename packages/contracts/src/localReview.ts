import * as Schema from "effect/Schema";

import { LocalReviewKey } from "./ids.ts";
import {
  AttemptId,
  AttemptSummary,
  FailureReason,
  ReviewActivity,
  ReviewCore,
  RevisionSummary,
} from "./review.ts";

/**
 * What a run reviews on top of the base: the working tree (staged, unstaged and untracked
 * changes included) or the committed branch tip alone.
 */
export const LocalHead = Schema.Literals(["working-tree", "branch"]);
export type LocalHead = typeof LocalHead.Type;

/** What a review of local changes is about, and the base and head its last run asked for. */
export const LocalSource = Schema.Struct({
  /** The work tree's folder name. */
  name: Schema.String,
  /** The work tree's top-level folder. */
  path: Schema.String,
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  /** Null when the run looked for the base itself. */
  base: Schema.NullOr(Schema.String),
  head: LocalHead,
});
export type LocalSource = typeof LocalSource.Type;

/** A file a run shows as committed (or leaves out when new), and why. */
export const LocalLeftOut = Schema.Struct({
  path: Schema.String,
  /** Over 50 MB, a git filter such as Git LFS names it, or a repository of its own. */
  reason: Schema.Literals(["too-large", "filtered", "nested-repository"]),
  bytes: Schema.NullOr(Schema.Int),
});
export type LocalLeftOut = typeof LocalLeftOut.Type;

/** What one run took from the repository, for the page header and the agent's prompt. */
export const LocalRun = Schema.Struct({
  /** The base as resolved, such as `origin/main`, and the user's merge-base commit. */
  baseRef: Schema.String,
  baseSha: Schema.String,
  /** The user's head commit when prkit read it; the attempt's headSha is prkit's own snapshot. */
  userHead: Schema.String,
  head: LocalHead,
  commitCount: Schema.Int,
  uncommitted: Schema.Boolean,
  leftOut: Schema.Array(LocalLeftOut),
  /** The author's own words about the change, quoted to the agent as a claim. */
  description: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
export type LocalRun = typeof LocalRun.Type;

/**
 * A local review's state as clients see it. Nothing watches local changes: a current guide
 * is `ready`, and the only way one ends is the user stopping it.
 */
export const LocalReviewStatus = Schema.Union([
  Schema.TaggedStruct("preparing", { attemptId: AttemptId }),
  Schema.TaggedStruct("writing", { attemptId: AttemptId, revision: Schema.Int }),
  Schema.TaggedStruct("ready", { checkedAt: Schema.String }),
  Schema.TaggedStruct("failed", {
    reason: FailureReason,
    message: Schema.String,
    attemptId: Schema.NullOr(AttemptId),
  }),
  Schema.TaggedStruct("done", { reason: Schema.Literal("stopped") }),
]);
export type LocalReviewStatus = typeof LocalReviewStatus.Type;

const { status: _status, ...core } = ReviewCore.fields;
/** A review of local changes: no account, and a source instead of a pull request. */
export const LocalReview = Schema.Struct({
  ...core,
  key: LocalReviewKey,
  source: LocalSource,
  status: LocalReviewStatus,
});
export type LocalReview = typeof LocalReview.Type;

/** Everything a local review's page needs except the guides themselves. */
export const LocalReviewSnapshot = Schema.Struct({
  key: LocalReviewKey,
  /** Null when there is none, or once it was removed. */
  review: Schema.NullOr(LocalReview),
  attempt: Schema.NullOr(AttemptSummary),
  revisions: Schema.Array(RevisionSummary),
  activity: Schema.Array(ReviewActivity),
  /** What the latest attempt's run took. */
  run: Schema.NullOr(LocalRun),
});
export type LocalReviewSnapshot = typeof LocalReviewSnapshot.Type;

/** Like `reviews.watch`: a snapshot first, then updates, and `removed` once it is deleted. */
export const LocalReviewWatchEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: LocalReviewSnapshot }),
  Schema.TaggedStruct("update", {
    review: LocalReview,
    attempt: Schema.NullOr(AttemptSummary),
    revisions: Schema.Array(RevisionSummary),
    /** Only the lines added since the last event. */
    activity: Schema.Array(ReviewActivity),
    run: Schema.NullOr(LocalRun),
  }),
  Schema.TaggedStruct("removed", {}),
]);
export type LocalReviewWatchEvent = typeof LocalReviewWatchEvent.Type;

/** One local review in the app-wide list. */
export const LocalReviewEntry = Schema.Struct({
  key: LocalReviewKey,
  source: LocalSource,
  status: Schema.Literals(["preparing", "writing", "ready", "failed", "done"]),
  latestRevision: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type LocalReviewEntry = typeof LocalReviewEntry.Type;

/**
 * `localReviews.feed`: every local review first, then each change, `ready` when a run's
 * guide is accepted, and `removed` when one is deleted. Apart from `reviews.feed`, whose
 * entries carry an account, so the Inbox never sees a local review.
 */
export const LocalReviewFeedEvent = Schema.Union([
  Schema.TaggedStruct("index", { reviews: Schema.Array(LocalReviewEntry) }),
  Schema.TaggedStruct("changed", { review: LocalReviewEntry }),
  Schema.TaggedStruct("ready", {
    key: LocalReviewKey,
    title: Schema.String,
    revision: Schema.Int,
    chapters: Schema.Int,
  }),
  Schema.TaggedStruct("removed", { key: LocalReviewKey }),
]);
export type LocalReviewFeedEvent = typeof LocalReviewFeedEvent.Type;

/** What a run request did: started a run, found one running, or found nothing new. */
export const LocalGenerateResult = Schema.Struct({
  outcome: Schema.Literals(["started", "running", "unchanged"]),
  snapshot: LocalReviewSnapshot,
  /** One line saying what happened, for the CLI and outside agents. */
  message: Schema.String,
});
export type LocalGenerateResult = typeof LocalGenerateResult.Type;

/** Why prkit couldn't read the user's repository, answered when the run is asked for. */
export const LocalReviewProblem = Schema.Literals([
  "not-a-repository",
  "bare-repository",
  "not-owned",
  "prkit-checkout",
  "sparse-checkout",
  "no-commits",
  "branch-not-found",
  "base-not-found",
  "no-shared-history",
  "nothing-changed",
  "missing-objects",
  "too-large",
  "moved",
  "repository-changed",
  "not-found",
]);
export type LocalReviewProblem = typeof LocalReviewProblem.Type;

export class LocalReviewError extends Schema.TaggedError<LocalReviewError>()("LocalReviewError", {
  reason: LocalReviewProblem,
  message: Schema.String,
}) {}
