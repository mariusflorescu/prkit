import * as Schema from "effect/Schema";

import { AgentInstanceId, AgentProviderKind } from "./agentInstance.ts";
import { DiffSnapshot } from "./diffSnapshot.ts";
import { AccountId, PullRequestKey, ReviewCommentId } from "./ids.ts";
import { ModelOptionSelection } from "./model.ts";
import { FileSide } from "./pullRequest.ts";

/** One writable agent session per PR, for review fixes and merge conflicts. */
export const FixerId = Schema.NonEmptyString.pipe(Schema.brand("FixerId"));
export type FixerId = typeof FixerId.Type;

/** One queued job of a fixer: a batch of comments, a conflict resolution, or a revert. */
export const FixerTurnId = Schema.NonEmptyString.pipe(Schema.brand("FixerTurnId"));
export type FixerTurnId = typeof FixerTurnId.Type;

/** What the user hands to the agent: one of prkit's drafts or a GitHub review thread. */
export const FixTarget = Schema.Union([
  Schema.TaggedStruct("draft", { id: ReviewCommentId }),
  Schema.TaggedStruct("thread", { threadId: Schema.NonEmptyString }),
]);
export type FixTarget = typeof FixTarget.Type;

/** A comment as the agent gets it. `id` is the short name it reports on ("c1"). */
export const FixComment = Schema.Struct({
  id: Schema.String,
  source: Schema.Union([
    Schema.TaggedStruct("draft", { draftId: ReviewCommentId }),
    Schema.TaggedStruct("thread", {
      threadId: Schema.String,
      url: Schema.NullOr(Schema.String),
      canReply: Schema.Boolean,
    }),
  ]),
  path: Schema.String,
  /** Its lines in the PR's diff; null for a thread GitHub marks outdated. */
  lines: Schema.NullOr(Schema.Struct({ side: FileSide, start: Schema.Int, end: Schema.Int })),
  /** The diff rows it was written on, each `+`, `-` or a space and then the line. */
  snippet: Schema.String,
  body: Schema.String,
});
export type FixComment = typeof FixComment.Type;

export const FixStatus = Schema.Literals(["fixed", "partly", "skipped"]);
export type FixStatus = typeof FixStatus.Type;

/** `finish_fixes`: the agent's commit message and what it did about each comment. */
export const FixReport = Schema.Struct({
  summary: Schema.String,
  perComment: Schema.Array(
    Schema.Struct({ commentId: Schema.String, status: FixStatus, note: Schema.String }),
  ),
});
export type FixReport = typeof FixReport.Type;

export const ConflictResolution = Schema.Literals(["ours", "theirs", "combined", "needs-human"]);
export type ConflictResolution = typeof ConflictResolution.Type;

/** `finish_conflicts`: a summary and how each conflicted file was resolved. */
export const ConflictReport = Schema.Struct({
  summary: Schema.String,
  perFile: Schema.Array(
    Schema.Struct({ path: Schema.String, resolution: ConflictResolution, note: Schema.String }),
  ),
});
export type ConflictReport = typeof ConflictReport.Type;

/**
 * Merge brings the base into the head (a merge commit, a normal push). Rebase
 * replays the PR onto the base and always needs a manual force-push with lease.
 */
export const ConflictStrategy = Schema.Literals(["merge", "rebase"]);
export type ConflictStrategy = typeof ConflictStrategy.Type;

/** A file git left conflicted; `needsHuman` files keep the base side and wait for the owner. */
export const ConflictedFile = Schema.Struct({ path: Schema.String, needsHuman: Schema.Boolean });
export type ConflictedFile = typeof ConflictedFile.Type;

/** What a turn works on, and what came back. The request part never changes once queued. */
export const FixerWork = Schema.Union([
  Schema.TaggedStruct("fix", {
    comments: Schema.NonEmptyArray(FixComment),
    /** Anything else the owner told the agent with this batch. */
    note: Schema.NullOr(Schema.String),
    /** Answer the GitHub threads in the batch once the fixes are pushed. */
    replyAfterPush: Schema.Boolean,
    report: Schema.NullOr(FixReport),
  }),
  Schema.TaggedStruct("conflicts", {
    strategy: ConflictStrategy,
    conflicted: Schema.Array(ConflictedFile),
    report: Schema.NullOr(ConflictReport),
  }),
  /** Undoes a pushed conflict resolution with a revert commit; no agent runs. */
  Schema.TaggedStruct("revert", { turnId: FixerTurnId, sha: Schema.String }),
]);
export type FixerWork = typeof FixerWork.Type;

export const FixerTrigger = Schema.Literals(["user", "auto", "retry", "redo"]);
export type FixerTrigger = typeof FixerTrigger.Type;

export const FixerDiscardReason = Schema.Literals([
  /** The owner discarded it. */
  "user",
  /** The branch moved before the push; a fresh turn redoes it on the new head. */
  "moved",
  /** The owner resolved the conflict outside prkit. */
  "outside",
  /** The new head no longer conflicts. */
  "upstream",
  /** The PR was merged or closed, or the session stopped. */
  "ended",
]);
export type FixerDiscardReason = typeof FixerDiscardReason.Type;

export const FixerFailureReason = Schema.Literals([
  "interrupted",
  "account",
  "github",
  "repository",
  "agent-auth",
  "agent",
  "no-report",
  "checks",
  "push",
]);
export type FixerFailureReason = typeof FixerFailureReason.Type;

/**
 * A turn's lifecycle (docs/internals/fix-agent.md). One turn per PR is past
 * `queued` and before an ending state at a time, so two never edit the worktree together.
 */
export const FixerTurnStatus = Schema.Union([
  Schema.TaggedStruct("queued", {}),
  Schema.TaggedStruct("preparing", {}),
  Schema.TaggedStruct("running", {}),
  /** A local commit waits for Push, Discard or a change request. */
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("pushing", {}),
  Schema.TaggedStruct("pushed", { at: Schema.String }),
  /** The agent finished without changing anything. */
  Schema.TaggedStruct("unchanged", {}),
  Schema.TaggedStruct("discarded", { reason: FixerDiscardReason, message: Schema.String }),
  Schema.TaggedStruct("failed", { reason: FixerFailureReason, message: Schema.String }),
]);
export type FixerTurnStatus = typeof FixerTurnStatus.Type;
export type FixerTurnState = FixerTurnStatus["_tag"];

/** States that hold the PR's worktree; the next queued turn waits for them to end. */
export const FIXER_BUSY: ReadonlyArray<FixerTurnState> = [
  "preparing",
  "running",
  "ready",
  "pushing",
];

/** Whether the fix agent may run the repository's check scripts on a PR, and why. */
export const ScriptAccess = Schema.Union([
  Schema.TaggedStruct("allowed", { reason: Schema.String }),
  Schema.TaggedStruct("blocked", { reason: Schema.String }),
]);
export type ScriptAccess = typeof ScriptAccess.Type;

/** One of the repository's check scripts and its command in the PR head's package.json. */
export const CheckScript = Schema.Struct({ name: Schema.String, command: Schema.String });
export type CheckScript = typeof CheckScript.Type;

/** The scripts one turn could run, decided when it checked out the PR head. */
export const TurnScripts = Schema.Union([
  Schema.TaggedStruct("allowed", { reason: Schema.String, scripts: Schema.Array(CheckScript) }),
  Schema.TaggedStruct("blocked", { reason: Schema.String }),
]);
export type TurnScripts = typeof TurnScripts.Type;

export const FixerCommit = Schema.Struct({
  sha: Schema.String,
  /** The PR head it was made on, then the base for a merge. */
  parents: Schema.Array(Schema.String),
  message: Schema.String,
});
export type FixerCommit = typeof FixerCommit.Type;

export const FixerTurn = Schema.Struct({
  id: FixerTurnId,
  work: FixerWork,
  trigger: FixerTrigger,
  status: FixerTurnStatus,
  provider: AgentProviderKind,
  instance: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  /** The PR head and base the turn was built on, known once fetched. */
  headSha: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  headRef: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(FixerCommit),
  /** Null until the turn has the checkout, and for a revert, which runs no agent. */
  scripts: Schema.NullOr(TurnScripts),
  /** The agent's latest line about what it is doing (`report_progress`). */
  narration: Schema.NullOr(Schema.String),
  /** How many times the owner asked the agent to change the result. */
  rounds: Schema.Int,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});
export type FixerTurn = typeof FixerTurn.Type;

export const FixerStatus = Schema.Union([
  Schema.TaggedStruct("active", {}),
  Schema.TaggedStruct("done", { reason: Schema.Literals(["merged", "closed", "stopped"]) }),
]);
export type FixerStatus = typeof FixerStatus.Type;

export const Fixer = Schema.Struct({
  id: FixerId,
  key: PullRequestKey,
  accountId: AccountId,
  provider: AgentProviderKind,
  instance: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  modelOptions: Schema.Array(ModelOptionSelection),
  sessionId: Schema.NullOr(Schema.String),
  status: FixerStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Fixer = typeof Fixer.Type;

export const FixerActivity = Schema.Struct({
  id: Schema.Int,
  turnId: FixerTurnId,
  at: Schema.String,
  kind: Schema.Literals(["phase", "tool", "note", "error"]),
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type FixerActivity = typeof FixerActivity.Type;

/** Per repository (`host/owner/repo`); all off unless the owner turns them on. */
export const RepositoryFixerSettings = Schema.Struct({
  repository: Schema.String,
  pushAutomatically: Schema.Boolean,
  resolveAutomatically: Schema.Boolean,
  /** Check scripts run on every PR here, not only on trusted authors' PRs from the repository itself. */
  runScriptsOnAnyPullRequest: Schema.Boolean,
});
export type RepositoryFixerSettings = typeof RepositoryFixerSettings.Type;

/** Automatic conflict resolutions per PR in a day before the watcher waits for a click. */
export const AUTO_RESOLVE_LIMIT = 3;

/** The Fixes tab: the session, its newest turns first, and the newest turn's activity. */
export const FixerSnapshot = Schema.Struct({
  key: PullRequestKey,
  fixer: Schema.NullOr(Fixer),
  turns: Schema.Array(FixerTurn),
  activity: Schema.Array(FixerActivity),
  settings: RepositoryFixerSettings,
  /** The repository resolves automatically, but this PR used the day's resolutions. */
  autoResolvePaused: Schema.Boolean,
});
export type FixerSnapshot = typeof FixerSnapshot.Type;

/** A turn's changes: the new commit's diff, or a resolution against each side. */
export const FixerDiff = Schema.Union([
  Schema.TaggedStruct("commit", { diff: DiffSnapshot }),
  Schema.TaggedStruct("resolution", {
    /** The conflicted files after the merge, compared with the PR's branch. */
    ours: DiffSnapshot,
    /** The same files compared with the base branch. */
    theirs: DiffSnapshot,
  }),
]);
export type FixerDiff = typeof FixerDiff.Type;

/** Whether this account can push to the PR's branch, as GitHub reports it. */
export const PushAccess = Schema.Union([
  Schema.TaggedStruct("allowed", { repository: Schema.String, branch: Schema.String }),
  Schema.TaggedStruct("denied", { reason: Schema.String }),
]);
export type PushAccess = typeof PushAccess.Type;

/** One PR's fixer for tabs and notifications: is the agent working, or waiting on you? */
export const FixerFeedEntry = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  state: Schema.Literals(["working", "waiting", "idle"]),
  /** Every turn the PR ever had, ended ones too: the Fixes tab shows from the first. */
  turns: Schema.Int,
});
export type FixerFeedEntry = typeof FixerFeedEntry.Type;

export const FixerFeedEvent = Schema.Union([
  Schema.TaggedStruct("index", { fixers: Schema.Array(FixerFeedEntry) }),
  Schema.TaggedStruct("changed", { fixer: FixerFeedEntry }),
  /** "Fixes ready", "Conflicts resolved", "Fixes pushed": worth a toast and a notification. */
  Schema.TaggedStruct("notice", {
    key: PullRequestKey,
    accountId: AccountId,
    title: Schema.String,
    body: Schema.String,
  }),
]);
export type FixerFeedEvent = typeof FixerFeedEvent.Type;

export class FixerError extends Schema.TaggedError<FixerError>()("FixerError", {
  message: Schema.String,
}) {}

/** The command doesn't apply to the turn's state, e.g. Push on a turn that is still running. */
export class FixerStateError extends Schema.TaggedError<FixerStateError>()("FixerStateError", {
  key: PullRequestKey,
  message: Schema.String,
}) {}
