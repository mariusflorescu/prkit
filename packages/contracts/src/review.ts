import * as Schema from "effect/Schema";

import { AgentSelection } from "./agent.ts";
import { AgentInstanceId, AgentProviderKind } from "./agentInstance.ts";
import { DiffSnapshot } from "./diffSnapshot.ts";
import { NormalizedGuide } from "./guide.ts";
import { AttemptConfig } from "./guideConfig.ts";
import { AccountId, PullRequestKey, ReviewId } from "./ids.ts";
import { ModelOptionSelection } from "./model.ts";

export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

export const FailureReason = Schema.Literals([
  "account",
  "github",
  "repository",
  "agent-auth",
  "agent",
  "no-guide",
  "interrupted",
  /** The reviewer's ignore rules skip every changed file. */
  "settings",
]);
export type FailureReason = typeof FailureReason.Type;

export const DoneReason = Schema.Literals(["merged", "closed", "stopped"]);
export type DoneReason = typeof DoneReason.Type;

/** See docs/internals/architecture.md "The review lifecycle". Times are ISO strings. */
export const ReviewStatus = Schema.Union([
  Schema.TaggedStruct("preparing", { attemptId: AttemptId }),
  Schema.TaggedStruct("writing", { attemptId: AttemptId, revision: Schema.Int }),
  Schema.TaggedStruct("watching", {
    headSha: Schema.String,
    /** The base branch the guide was written against; absent on reviews from before stacks. */
    baseRef: Schema.optionalKey(Schema.String),
    checkedAt: Schema.String,
  }),
  Schema.TaggedStruct("failed", {
    reason: FailureReason,
    message: Schema.String,
    attemptId: Schema.NullOr(AttemptId),
  }),
  Schema.TaggedStruct("done", { reason: DoneReason }),
]);
export type ReviewStatus = typeof ReviewStatus.Type;

export const Review = Schema.Struct({
  id: ReviewId,
  key: PullRequestKey,
  accountId: AccountId,
  /** The instance's kind, kept with it so a removed instance still shows the right agent. */
  provider: AgentProviderKind,
  instance: AgentInstanceId,
  /** Null for reviews started before prkit offered a model choice: the agent's own default. */
  model: Schema.NullOr(Schema.String),
  modelOptions: Schema.Array(ModelOptionSelection),
  sessionId: Schema.NullOr(Schema.String),
  status: ReviewStatus,
  latestRevision: Schema.NullOr(Schema.Int),
  /** Why the watcher's last read of the PR failed; null once a read succeeds. */
  watchProblem: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Review = typeof Review.Type;

export const AttemptTrigger = Schema.Literals([
  "first",
  "new-commits",
  "rewritten",
  /** The PR's base branch changed, as when the layer below it in a stack merged. */
  "retargeted",
  "retry",
]);
export type AttemptTrigger = typeof AttemptTrigger.Type;

/** The fixed steps the loading view shows, in order. */
export const ReviewPhase = Schema.Literals([
  "queued",
  "preparing-code",
  "reading-change",
  "writing-guide",
  "checking-guide",
]);
export type ReviewPhase = typeof ReviewPhase.Type;

export const ReviewActivityKind = Schema.Literals(["phase", "tool", "note", "error"]);
export const ReviewActivity = Schema.Struct({
  id: Schema.Int,
  attemptId: AttemptId,
  at: Schema.String,
  kind: ReviewActivityKind,
  text: Schema.String,
  /** The raw tool call behind a `tool` line, for the Details disclosure. */
  detail: Schema.NullOr(Schema.String),
});
export type ReviewActivity = typeof ReviewActivity.Type;

/**
 * One changed file as the agent works through it. `read` comes from the agent's
 * own tool calls (a read that returned), never from what it says it did.
 */
export const AttemptFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  additions: Schema.Int,
  deletions: Schema.Int,
  read: Schema.Literals(["unread", "reading", "read"]),
  /** The agent's one line about the file (`note_file`). */
  note: Schema.NullOr(Schema.String),
});
export type AttemptFile = typeof AttemptFile.Type;

/** The chapters of the draft so far, in order; a chapter is written once it has files. */
export const DraftOutline = Schema.Struct({
  version: Schema.Int,
  chapters: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, written: Schema.Boolean }),
  ),
  /**
   * The agent is still adding chapters to a streamed `submit_guide`: `chapters` is
   * what it has written so far, not a plan, so its length is not the total.
   */
  growing: Schema.Boolean,
});
export type DraftOutline = typeof DraftOutline.Type;

export const AttemptSummary = Schema.Struct({
  id: AttemptId,
  revision: Schema.Int,
  trigger: AttemptTrigger,
  /** Null until the attempt has fetched the PR's head. */
  headSha: Schema.NullOr(Schema.String),
  /** Commits since the previous revision's head, known once the head is fetched (`new-commits` only). */
  commits: Schema.NullOr(Schema.Int),
  phase: ReviewPhase,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  /** The agent's latest line about what it is doing (`report_progress`); replaced, not a log. */
  narration: Schema.NullOr(Schema.String),
  /** The diff's files in order, empty until the head is fetched. */
  files: Schema.Array(AttemptFile),
  draft: Schema.NullOr(DraftOutline),
});
export type AttemptSummary = typeof AttemptSummary.Type;

export const RevisionSummary = Schema.Struct({
  revision: Schema.Int,
  attemptId: AttemptId,
  trigger: AttemptTrigger,
  headSha: Schema.String,
  createdAt: Schema.String,
});
export type RevisionSummary = typeof RevisionSummary.Type;

/**
 * Everything the Guide tab needs except the guides themselves. `review` is null
 * before the first Generate; `revisions` is oldest first.
 */
export const ReviewSnapshot = Schema.Struct({
  key: PullRequestKey,
  review: Schema.NullOr(Review),
  attempt: Schema.NullOr(AttemptSummary),
  revisions: Schema.Array(RevisionSummary),
  activity: Schema.Array(ReviewActivity),
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;

/**
 * `reviews.watch` starts every subscription with a full snapshot, so a client
 * that reconnects replaces what it had before trusting later updates. Updates
 * carry the current status and only the activity lines added since.
 */
export const ReviewWatchEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: ReviewSnapshot }),
  Schema.TaggedStruct("update", {
    review: Review,
    attempt: Schema.NullOr(AttemptSummary),
    revisions: Schema.Array(RevisionSummary),
    activity: Schema.Array(ReviewActivity),
  }),
]);
export type ReviewWatchEvent = typeof ReviewWatchEvent.Type;

export const GuideRevision = Schema.Struct({
  revision: Schema.Int,
  headSha: Schema.String,
  createdAt: Schema.String,
  normalized: NormalizedGuide,
  snapshot: DiffSnapshot,
  /** The guide settings the revision was written with, exactly as its attempt froze them. */
  config: AttemptConfig,
});
export type GuideRevision = typeof GuideRevision.Type;

/** The latest `submit_draft` of an attempt, ready to render against the attempt's snapshot. */
export const DraftGuideResult = Schema.Struct({
  attemptId: AttemptId,
  version: Schema.Int,
  normalized: NormalizedGuide,
});
export type DraftGuideResult = typeof DraftGuideResult.Type;

/** The typical click-to-guide time of past guides on PRs of a similar size. */
export const TypicalDuration = Schema.Struct({ seconds: Schema.Int, samples: Schema.Int });
export type TypicalDuration = typeof TypicalDuration.Type;

/** One review in the app-wide feed: enough for inbox marks, tabs and notifications. */
export const ReviewFeedEntry = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  status: Schema.Literals(["preparing", "writing", "watching", "failed", "done"]),
  latestRevision: Schema.NullOr(Schema.Int),
});
export type ReviewFeedEntry = typeof ReviewFeedEntry.Type;

/**
 * `reviews.feed` opens with every review, then sends each change, `ready` when a
 * guide the user asked for (or auto mode started) is accepted, and `stack-ready`
 * once every guide of a stack's batch has finished, instead of a `ready` for each.
 */
export const ReviewFeedEvent = Schema.Union([
  Schema.TaggedStruct("index", { reviews: Schema.Array(ReviewFeedEntry) }),
  Schema.TaggedStruct("changed", { review: ReviewFeedEntry }),
  Schema.TaggedStruct("ready", {
    key: PullRequestKey,
    accountId: AccountId,
    title: Schema.String,
    revision: Schema.Int,
    chapters: Schema.Int,
  }),
  Schema.TaggedStruct("stack-ready", {
    /** The PR the batch was started from; the notification opens its guide. */
    key: PullRequestKey,
    accountId: AccountId,
    ready: Schema.Int,
    failed: Schema.Int,
  }),
]);
export type ReviewFeedEvent = typeof ReviewFeedEvent.Type;

/** Settings > Guides. `defaultAgent` null means the first ready agent's default model. */
export const GuideSettings = Schema.Struct({
  defaultAgent: Schema.NullOr(AgentSelection),
  /** Accounts whose review requests get a guide without a click. */
  autoAccounts: Schema.Array(AccountId),
});
export type GuideSettings = typeof GuideSettings.Type;

export class GuideSettingsError extends Schema.TaggedError<GuideSettingsError>()(
  "GuideSettingsError",
  { message: Schema.String },
) {}

export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

/** The command doesn't apply to the review's current state, e.g. Retry on a review that is writing. */
export class ReviewStateError extends Schema.TaggedError<ReviewStateError>()("ReviewStateError", {
  key: PullRequestKey,
  message: Schema.String,
}) {}

export class GuideNotFoundError extends Schema.TaggedError<GuideNotFoundError>()(
  "GuideNotFoundError",
  { key: PullRequestKey, message: Schema.String },
) {}
