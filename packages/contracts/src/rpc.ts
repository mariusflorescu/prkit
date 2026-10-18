import { CliInstallError, CliInstallState } from "./cliInstall.ts";
import * as Schema from "effect/Schema";
import { PullRequestTimeline } from "./pullRequestTimeline.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AccountsError,
  AccountsResult,
  ConfigDirAlreadyAddedError,
  ConfigDirNoHostsError,
  ConfigDirNotAddedError,
  ConfigDirNotFoundError,
} from "./accounts.ts";
import {
  AgentCatalog,
  AgentSelection,
  AgentSignInError,
  AgentSignInPage,
  CursorSdkInstallError,
  CursorSdkInstallProgress,
} from "./agent.ts";
import { AgentInstanceConfig, AgentInstanceError, AgentInstanceId } from "./agentInstance.ts";
import { DiffSnapshot } from "./diffSnapshot.ts";
import { DIFF_TEXT_BATCH, DiffSource, DiffTexts, DiffTextsError } from "./diffTexts.ts";
import {
  FindRepositoryInput,
  GuidanceEdit,
  GuideConfigConflict,
  GuideConfigError,
  GuideConfigSave,
  GuideRepository,
  GuideScope,
  PullRequestGuideConfig,
  ScopeConfig,
} from "./guideConfig.ts";
import {
  ConflictStrategy,
  FixerDiff,
  FixerError,
  FixerFeedEvent,
  FixerSnapshot,
  FixerStateError,
  FixerTurnId,
  FixerWorkRefused,
  FixTarget,
  PushAccess,
  RepositoryFixerSettings,
  ScriptAccess,
} from "./fixer.ts";
import {
  AccountId,
  LocalReviewKey,
  PullRequestKey,
  ReviewCommentId,
  ReviewKey,
  ReviewSubject,
} from "./ids.ts";
import {
  LocalGenerateResult,
  LocalReviewEntry,
  LocalReviewError,
  LocalReviewFeedEvent,
  LocalReviewSnapshot,
  LocalReviewWatchEvent,
} from "./localReview.ts";
import { GitHubBudget, GitHubEvent } from "./github.ts";
import { InboxError, InboxRead, InboxResult } from "./inbox.ts";
import {
  RepositoryError,
  RepositoryList,
  RepositoryListRead,
  RepositoryPullRequests,
} from "./repositories.ts";
import {
  FileContents,
  FileSide,
  PullRequestDetail,
  PullRequestFiles,
  PullRequestReadError,
} from "./pullRequest.ts";
import {
  CommentPlacement,
  NoteRef,
  PendingComments,
  ReviewCommentsError,
  ReviewEvent,
  ReviewSubmitted,
  ReviewThreads,
} from "./reviewComments.ts";
import { AppearanceChange, AppearanceSettings, AppearanceSettingsError } from "./appearance.ts";
import {
  ReviewedDecision,
  ReviewedFilesChange,
  ReviewedFilesError,
  ReviewedMarks,
} from "./reviewedFiles.ts";
import {
  ManualCheckDecision,
  ManualCheckTicks,
  ManualCheckTicksChange,
  ManualCheckTicksError,
} from "./manualCheckTicks.ts";
import { PullRequestStack, StackGuidesResult } from "./stack.ts";
import { InboxFilters, Workspace, WorkspaceChange, WorkspaceError } from "./workspace.ts";
import { OutsideAccess, OutsideAgentsError, OutsideAgentsState } from "./outsideAgents.ts";
import {
  PullRequestActionError,
  PullRequestActionResult,
  PullRequestCandidates,
  PullRequestCommand,
} from "./pullRequestActions.ts";
import {
  AttemptId,
  DraftGuideResult,
  GuideNotFoundError,
  GuideRevision,
  GuideSettings,
  GuideSettingsError,
  ReviewError,
  ReviewFeedEvent,
  ReviewSnapshot,
  ReviewStateError,
  ReviewWatchEvent,
  TypicalDuration,
} from "./review.ts";

export const WS_METHODS = {
  appInfo: "app.info",
  accountsList: "accounts.list",
  accountsRefresh: "accounts.refresh",
  accountsAddConfigDir: "accounts.addConfigDir",
  accountsRemoveConfigDir: "accounts.removeConfigDir",
  inboxList: "inbox.list",
  repositoriesList: "repositories.list",
  repositoriesPullRequests: "repositories.pullRequests",
  githubBudget: "github.budget",
  githubEvents: "github.events",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsRefresh: "pullRequests.refresh",
  pullRequestsFiles: "pullRequests.files",
  pullRequestsTimeline: "pullRequests.timeline",
  pullRequestsFileContents: "pullRequests.fileContents",
  diffsTexts: "diffs.texts",
  pullRequestsExecute: "pullRequests.execute",
  pullRequestsCandidates: "pullRequests.candidates",
  workspaceGet: "workspace.get",
  workspaceOpen: "workspace.open",
  workspaceClose: "workspace.close",
  workspaceActivate: "workspace.activate",
  workspaceReorder: "workspace.reorder",
  workspaceOpenLocal: "workspace.openLocal",
  workspaceCloseLocal: "workspace.closeLocal",
  workspaceSaveInboxFilters: "workspace.saveInboxFilters",
  workspaceChanges: "workspace.changes",
  reviewedFilesGet: "reviewedFiles.get",
  reviewedFilesSet: "reviewedFiles.set",
  reviewedFilesChanges: "reviewedFiles.changes",
  manualCheckTicksGet: "manualCheckTicks.get",
  manualCheckTicksSet: "manualCheckTicks.set",
  manualCheckTicksChanges: "manualCheckTicks.changes",
  reviewsGet: "reviews.get",
  reviewsGenerate: "reviews.generate",
  reviewsGenerateStack: "reviews.generateStack",
  reviewsStop: "reviews.stop",
  reviewsRetry: "reviews.retry",
  reviewsWatch: "reviews.watch",
  reviewsFeed: "reviews.feed",
  reviewsDiff: "reviews.diff",
  reviewsTypicalDuration: "reviews.typicalDuration",
  guidesGet: "guides.get",
  localReviewsList: "localReviews.list",
  localReviewsFeed: "localReviews.feed",
  localReviewsGet: "localReviews.get",
  localReviewsWatch: "localReviews.watch",
  localReviewsGenerate: "localReviews.generate",
  localReviewsStop: "localReviews.stop",
  localReviewsRetry: "localReviews.retry",
  localReviewsRemove: "localReviews.remove",
  localReviewsFileContents: "localReviews.fileContents",
  reviewCommentsList: "reviewComments.list",
  reviewCommentsAdd: "reviewComments.add",
  reviewCommentsAddFromNote: "reviewComments.addFromNote",
  reviewCommentsEdit: "reviewComments.edit",
  reviewCommentsMove: "reviewComments.move",
  reviewCommentsDelete: "reviewComments.delete",
  reviewCommentsSubmit: "reviewComments.submit",
  reviewThreadsList: "reviewThreads.list",
  reviewThreadsReply: "reviewThreads.reply",
  reviewThreadsResolve: "reviewThreads.resolve",
  guidesDraft: "guides.draft",
  guideSettingsGet: "guideSettings.get",
  guideSettingsUpdate: "guideSettings.update",
  appearanceGet: "appearance.get",
  appearanceUpdate: "appearance.update",
  guideConfigScope: "guideConfig.scope",
  guideConfigPullRequest: "guideConfig.pullRequest",
  guideConfigRepositories: "guideConfig.repositories",
  guideConfigFindRepository: "guideConfig.findRepository",
  guideConfigSave: "guideConfig.save",
  agentsCatalog: "agents.catalog",
  agentsSignIn: "agents.signIn",
  agentsSignOut: "agents.signOut",
  agentsCreate: "agents.create",
  agentsUpdate: "agents.update",
  agentsRemove: "agents.remove",
  agentsReset: "agents.reset",
  agentsInstallCursor: "agents.installCursor",
  fixersGet: "fixers.get",
  fixersWatch: "fixers.watch",
  fixersFeed: "fixers.feed",
  fixersSend: "fixers.send",
  fixersResolveConflicts: "fixers.resolveConflicts",
  fixersPush: "fixers.push",
  fixersDiscard: "fixers.discard",
  fixersRevise: "fixers.revise",
  fixersRetry: "fixers.retry",
  fixersRevert: "fixers.revert",
  fixersStop: "fixers.stop",
  fixersDiff: "fixers.diff",
  fixersPatch: "fixers.patch",
  fixersPushAccess: "fixers.pushAccess",
  fixersScriptAccess: "fixers.scriptAccess",
  fixerSettingsList: "fixerSettings.list",
  fixerSettingsUpdate: "fixerSettings.update",
  cliInstallGet: "cliInstall.get",
  cliInstall: "cliInstall.install",
  cliUninstall: "cliInstall.uninstall",
  cliSkillInstall: "cliInstall.skill",
  outsideAgentsGet: "outsideAgents.get",
  outsideAgentsUpdate: "outsideAgents.update",
  outsideAgentsReset: "outsideAgents.reset",
} as const;

export const AppInfo = Schema.Struct({
  version: Schema.String,
  /** "development" outside a build. */
  buildId: Schema.String,
  home: Schema.String,
  startedAt: Schema.String,
});
export type AppInfo = typeof AppInfo.Type;

export const WsAppInfoRpc = Rpc.make(WS_METHODS.appInfo, {
  payload: Schema.Struct({}),
  success: AppInfo,
});

export const WsRpcGroup = RpcGroup.make(
  WsAppInfoRpc,
  Rpc.make(WS_METHODS.accountsList, {
    payload: Schema.Struct({}),
    success: AccountsResult,
    error: AccountsError,
  }),
  Rpc.make(WS_METHODS.accountsRefresh, {
    payload: Schema.Struct({}),
    success: AccountsResult,
    error: AccountsError,
  }),
  Rpc.make(WS_METHODS.accountsAddConfigDir, {
    payload: Schema.Struct({ path: Schema.NonEmptyString }),
    success: AccountsResult,
    error: Schema.Union([
      AccountsError,
      ConfigDirNotFoundError,
      ConfigDirNoHostsError,
      ConfigDirAlreadyAddedError,
    ]),
  }),
  Rpc.make(WS_METHODS.accountsRemoveConfigDir, {
    payload: Schema.Struct({ path: Schema.NonEmptyString }),
    success: AccountsResult,
    error: Schema.Union([AccountsError, ConfigDirNotAddedError]),
  }),
  Rpc.make(WS_METHODS.inboxList, {
    payload: Schema.Struct({ read: InboxRead }),
    success: InboxResult,
    error: InboxError,
  }),
  /** Every repository the accounts can see; read from GitHub at most once a day unless refreshed. */
  Rpc.make(WS_METHODS.repositoriesList, {
    payload: Schema.Struct({ read: RepositoryListRead }),
    success: RepositoryList,
    error: RepositoryError,
  }),
  /** One repository's open pull requests, read through the account given. */
  Rpc.make(WS_METHODS.repositoriesPullRequests, {
    payload: Schema.Struct({
      accountId: AccountId,
      host: Schema.String,
      owner: Schema.String,
      name: Schema.String,
    }),
    success: RepositoryPullRequests,
    error: RepositoryError,
  }),
  Rpc.make(WS_METHODS.githubBudget, {
    payload: Schema.Struct({}),
    success: GitHubBudget,
  }),
  /** Open while a window is visible; the server fingerprints open PR tabs only then. */
  Rpc.make(WS_METHODS.githubEvents, {
    payload: Schema.Struct({}),
    success: GitHubEvent,
    stream: true,
  }),
  Rpc.make(WS_METHODS.pullRequestsDetail, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PullRequestDetail,
    error: PullRequestReadError,
  }),
  /** The stack this PR belongs to, bottom to top; null when it isn't in one. */
  Rpc.make(WS_METHODS.pullRequestsStack, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: Schema.NullOr(PullRequestStack),
    error: PullRequestReadError,
  }),
  /** Marks every cached read of this PR stale, so the next reads go to GitHub. */
  Rpc.make(WS_METHODS.pullRequestsRefresh, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
  }),
  Rpc.make(WS_METHODS.pullRequestsExecute, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      command: PullRequestCommand,
    }),
    success: PullRequestActionResult,
    error: PullRequestActionError,
  }),
  Rpc.make(WS_METHODS.pullRequestsCandidates, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PullRequestCandidates,
    error: PullRequestActionError,
  }),
  Rpc.make(WS_METHODS.pullRequestsFiles, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PullRequestFiles,
    error: PullRequestReadError,
  }),
  Rpc.make(WS_METHODS.pullRequestsTimeline, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PullRequestTimeline,
    error: PullRequestReadError,
  }),
  Rpc.make(WS_METHODS.pullRequestsFileContents, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      path: Schema.String,
      side: FileSide,
    }),
    success: FileContents,
    error: PullRequestReadError,
  }),
  Rpc.make(WS_METHODS.diffsTexts, {
    payload: Schema.Struct({
      source: DiffSource,
      paths: Schema.Array(Schema.String).check(Schema.isMaxLength(DIFF_TEXT_BATCH)),
    }),
    success: DiffTexts,
    error: DiffTextsError,
  }),
  Rpc.make(WS_METHODS.workspaceGet, {
    payload: Schema.Struct({}),
    success: Workspace,
    error: WorkspaceError,
  }),
  Rpc.make(WS_METHODS.workspaceOpen, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: Workspace,
    error: WorkspaceError,
  }),
  Rpc.make(WS_METHODS.workspaceClose, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: Workspace,
    error: WorkspaceError,
  }),
  Rpc.make(WS_METHODS.workspaceActivate, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: Workspace,
    error: WorkspaceError,
  }),
  Rpc.make(WS_METHODS.workspaceReorder, {
    payload: Schema.Struct({ keys: Schema.Array(PullRequestKey) }),
    success: Workspace,
    error: WorkspaceError,
  }),
  // A local review's tab: opening it never makes it the active tab.
  Rpc.make(WS_METHODS.workspaceOpenLocal, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: Workspace,
    error: WorkspaceError,
  }),
  Rpc.make(WS_METHODS.workspaceCloseLocal, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: Workspace,
    error: WorkspaceError,
  }),
  // The tabs with the saved filters, versioned like every other copy of them.
  Rpc.make(WS_METHODS.workspaceSaveInboxFilters, {
    payload: InboxFilters,
    success: Workspace,
    error: WorkspaceError,
  }),
  // The open tabs as they are, then each change made by something other than this window.
  Rpc.make(WS_METHODS.workspaceChanges, {
    payload: Schema.Struct({}),
    success: WorkspaceChange,
    error: WorkspaceError,
    stream: true,
  }),
  // The files the user marked reviewed (docs/internals/architecture.md "Reviewed files").
  Rpc.make(WS_METHODS.reviewedFilesGet, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: ReviewedMarks,
    error: ReviewedFilesError,
  }),
  Rpc.make(WS_METHODS.reviewedFilesSet, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      decision: ReviewedDecision,
    }),
    success: ReviewedMarks,
    error: ReviewedFilesError,
  }),
  // Decisions saved by anything, an outside agent included, so open windows read them again.
  Rpc.make(WS_METHODS.reviewedFilesChanges, {
    payload: Schema.Struct({}),
    success: ReviewedFilesChange,
    stream: true,
  }),
  // The manual check steps the reader ticked (docs/internals/architecture.md "Manual checks").
  Rpc.make(WS_METHODS.manualCheckTicksGet, {
    payload: Schema.Struct({ subject: ReviewSubject }),
    success: ManualCheckTicks,
    error: ManualCheckTicksError,
  }),
  Rpc.make(WS_METHODS.manualCheckTicksSet, {
    payload: Schema.Struct({ subject: ReviewSubject, decision: ManualCheckDecision }),
    success: ManualCheckTicks,
    error: ManualCheckTicksError,
  }),
  Rpc.make(WS_METHODS.manualCheckTicksChanges, {
    payload: Schema.Struct({}),
    success: ManualCheckTicksChange,
    stream: true,
  }),
  // Reviews, guides and agents (docs/internals/architecture.md "The review lifecycle").
  Rpc.make(WS_METHODS.reviewsGet, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: ReviewSnapshot,
    error: ReviewError,
  }),
  Rpc.make(WS_METHODS.reviewsGenerate, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      /** Absent: the review's own selection, else the default in Settings > Guides. */
      agent: Schema.optionalKey(AgentSelection),
      /** The PR's guidance block as typed in the composer, saved before the guide starts. */
      guidance: Schema.optionalKey(GuidanceEdit),
    }),
    success: ReviewSnapshot,
    error: Schema.Union([ReviewError, ReviewStateError, GuideConfigError, GuideConfigConflict]),
  }),
  /**
   * One guide for each chosen layer of the stack `key` belongs to, bottom to top, with
   * one agent. Layers that already have a guide are skipped unless `regenerate`.
   */
  Rpc.make(WS_METHODS.reviewsGenerateStack, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      /** PR numbers of the chosen layers, in this PR's repository. */
      layers: Schema.NonEmptyArray(Schema.Int),
      regenerate: Schema.Boolean,
      agent: Schema.optionalKey(AgentSelection),
      /** This PR's guidance block as typed in the composer, saved before the guides start. */
      guidance: Schema.optionalKey(GuidanceEdit),
    }),
    success: StackGuidesResult,
    error: Schema.Union([ReviewError, ReviewStateError, GuideConfigError, GuideConfigConflict]),
  }),
  Rpc.make(WS_METHODS.reviewsStop, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: ReviewSnapshot,
    error: Schema.Union([ReviewError, ReviewStateError]),
  }),
  Rpc.make(WS_METHODS.reviewsRetry, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: ReviewSnapshot,
    error: Schema.Union([ReviewError, ReviewStateError]),
  }),
  Rpc.make(WS_METHODS.reviewsWatch, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: ReviewWatchEvent,
    error: ReviewError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.reviewsFeed, {
    payload: Schema.Struct({}),
    success: ReviewFeedEvent,
    error: ReviewError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.reviewsDiff, {
    payload: Schema.Struct({ key: ReviewKey, attemptId: AttemptId }),
    success: DiffSnapshot,
    error: Schema.Union([ReviewError, GuideNotFoundError]),
  }),
  Rpc.make(WS_METHODS.reviewsTypicalDuration, {
    payload: Schema.Struct({ instance: AgentInstanceId, lines: Schema.Int }),
    success: Schema.NullOr(TypicalDuration),
    error: ReviewError,
  }),
  Rpc.make(WS_METHODS.guidesGet, {
    payload: Schema.Struct({ key: ReviewKey, revision: Schema.optionalKey(Schema.Int) }),
    success: GuideRevision,
    error: Schema.Union([ReviewError, GuideNotFoundError]),
  }),
  Rpc.make(WS_METHODS.guidesDraft, {
    payload: Schema.Struct({ key: ReviewKey, attemptId: AttemptId }),
    success: DraftGuideResult,
    error: Schema.Union([ReviewError, GuideNotFoundError]),
  }),
  // Guides of local changes (docs/internals/architecture.md "Local reviews"). The CLI and
  // outside agents start them from a folder; the app runs them again, stops and removes them.
  Rpc.make(WS_METHODS.localReviewsList, {
    payload: Schema.Struct({}),
    success: Schema.Array(LocalReviewEntry),
    error: ReviewError,
  }),
  Rpc.make(WS_METHODS.localReviewsFeed, {
    payload: Schema.Struct({}),
    success: LocalReviewFeedEvent,
    error: ReviewError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.localReviewsGet, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: LocalReviewSnapshot,
    error: ReviewError,
  }),
  Rpc.make(WS_METHODS.localReviewsWatch, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: LocalReviewWatchEvent,
    error: ReviewError,
    stream: true,
  }),
  /** Run again: a new snapshot of the same folder, branch, base and head. */
  Rpc.make(WS_METHODS.localReviewsGenerate, {
    payload: Schema.Struct({
      key: LocalReviewKey,
      /** Absent: the review's own selection. */
      agent: Schema.optionalKey(AgentSelection),
      /** Write the guide again even when nothing changed since the last revision. */
      regenerate: Schema.optionalKey(Schema.Boolean),
    }),
    success: LocalGenerateResult,
    error: Schema.Union([ReviewError, LocalReviewError]),
  }),
  Rpc.make(WS_METHODS.localReviewsStop, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: LocalReviewSnapshot,
    error: ReviewError,
  }),
  /** A failed run again, on the snapshot it took. */
  Rpc.make(WS_METHODS.localReviewsRetry, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: LocalReviewSnapshot,
    error: Schema.Union([ReviewError, ReviewStateError]),
  }),
  /** Deletes the review, its revisions and prkit's copy of its snapshots. */
  Rpc.make(WS_METHODS.localReviewsRemove, {
    payload: Schema.Struct({ key: LocalReviewKey }),
    success: Schema.Struct({}),
    error: ReviewError,
  }),
  /** A file as one revision's snapshot (new) or its base (old) holds it. */
  Rpc.make(WS_METHODS.localReviewsFileContents, {
    payload: Schema.Struct({
      key: LocalReviewKey,
      revision: Schema.Int,
      path: Schema.String,
      side: FileSide,
    }),
    success: FileContents,
    error: Schema.Union([ReviewError, GuideNotFoundError]),
  }),
  Rpc.make(WS_METHODS.guideSettingsGet, {
    payload: Schema.Struct({}),
    success: GuideSettings,
    error: GuideSettingsError,
  }),
  Rpc.make(WS_METHODS.guideSettingsUpdate, {
    payload: Schema.Struct({
      defaultAgent: Schema.optionalKey(Schema.NullOr(AgentSelection)),
      autoAccounts: Schema.optionalKey(Schema.Array(AccountId)),
    }),
    success: GuideSettings,
    error: GuideSettingsError,
  }),
  Rpc.make(WS_METHODS.appearanceGet, {
    payload: Schema.Struct({}),
    success: AppearanceSettings,
    error: AppearanceSettingsError,
  }),
  Rpc.make(WS_METHODS.appearanceUpdate, {
    payload: AppearanceChange,
    success: AppearanceSettings,
    error: AppearanceSettingsError,
  }),
  // Guide settings: Global, Repository and PR scopes (docs/internals/architecture.md "Guide settings").
  Rpc.make(WS_METHODS.guideConfigScope, {
    payload: Schema.Struct({ scope: GuideScope }),
    success: ScopeConfig,
    error: GuideConfigError,
  }),
  Rpc.make(WS_METHODS.guideConfigPullRequest, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PullRequestGuideConfig,
    error: GuideConfigError,
  }),
  Rpc.make(WS_METHODS.guideConfigRepositories, {
    payload: Schema.Struct({}),
    success: Schema.Array(GuideRepository),
    error: GuideConfigError,
  }),
  Rpc.make(WS_METHODS.guideConfigFindRepository, {
    payload: FindRepositoryInput,
    success: GuideRepository,
    error: GuideConfigError,
  }),
  Rpc.make(WS_METHODS.guideConfigSave, {
    payload: GuideConfigSave,
    success: ScopeConfig,
    error: Schema.Union([GuideConfigError, GuideConfigConflict]),
  }),
  // `instance` checks only that one again; `refresh` without it checks every instance.
  Rpc.make(WS_METHODS.agentsCatalog, {
    payload: Schema.Struct({
      refresh: Schema.Boolean,
      instance: Schema.optionalKey(AgentInstanceId),
    }),
    success: AgentCatalog,
  }),
  // prkit's own login for an agent: the sign-in page, then the stream ends once it signed in.
  Rpc.make(WS_METHODS.agentsSignIn, {
    payload: Schema.Struct({ instance: AgentInstanceId }),
    success: AgentSignInPage,
    error: AgentSignInError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.agentsSignOut, {
    payload: Schema.Struct({ instance: AgentInstanceId }),
    success: AgentCatalog,
    error: AgentSignInError,
  }),
  // Agent instances (Settings > Agents). A sensitive variable sent back empty and redacted keeps its value.
  Rpc.make(WS_METHODS.agentsCreate, {
    payload: Schema.Struct({ config: AgentInstanceConfig }),
    success: AgentCatalog,
    error: AgentInstanceError,
  }),
  Rpc.make(WS_METHODS.agentsUpdate, {
    payload: Schema.Struct({ config: AgentInstanceConfig }),
    success: AgentCatalog,
    error: AgentInstanceError,
  }),
  Rpc.make(WS_METHODS.agentsRemove, {
    payload: Schema.Struct({ instance: AgentInstanceId }),
    success: AgentCatalog,
    error: AgentInstanceError,
  }),
  Rpc.make(WS_METHODS.agentsReset, {
    payload: Schema.Struct({ instance: AgentInstanceId }),
    success: AgentCatalog,
    error: AgentInstanceError,
  }),
  // Downloads Cursor's SDK into prkit's folder, on the user's request: progress, then the end.
  Rpc.make(WS_METHODS.agentsInstallCursor, {
    payload: Schema.Struct({}),
    success: CursorSdkInstallProgress,
    error: CursorSdkInstallError,
    stream: true,
  }),
  // Pending review comments and GitHub review threads.
  Rpc.make(WS_METHODS.reviewCommentsList, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsAdd, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      placement: CommentPlacement,
      body: Schema.NonEmptyString,
    }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsAddFromNote, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      note: NoteRef,
      body: Schema.NonEmptyString,
    }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsEdit, {
    payload: Schema.Struct({ id: ReviewCommentId, body: Schema.NonEmptyString }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsMove, {
    payload: Schema.Struct({ id: ReviewCommentId, placement: CommentPlacement }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsDelete, {
    payload: Schema.Struct({ id: ReviewCommentId }),
    success: PendingComments,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewCommentsSubmit, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      event: ReviewEvent,
      body: Schema.String,
    }),
    success: ReviewSubmitted,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewThreadsList, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: ReviewThreads,
    error: PullRequestReadError,
  }),
  Rpc.make(WS_METHODS.reviewThreadsReply, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      threadId: Schema.NonEmptyString,
      body: Schema.NonEmptyString,
    }),
    success: ReviewThreads,
    error: ReviewCommentsError,
  }),
  Rpc.make(WS_METHODS.reviewThreadsResolve, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      threadId: Schema.NonEmptyString,
      resolved: Schema.Boolean,
    }),
    success: ReviewThreads,
    error: ReviewCommentsError,
  }),
  // The fix agent: review fixes and merge conflicts (docs/internals/fix-agent.md).
  Rpc.make(WS_METHODS.fixersGet, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: FixerSnapshot,
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixersWatch, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: FixerSnapshot,
    error: FixerError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.fixersFeed, {
    payload: Schema.Struct({}),
    success: FixerFeedEvent,
    error: FixerError,
    stream: true,
  }),
  Rpc.make(WS_METHODS.fixersSend, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      /** Absent: the session's own agent, else the default in Settings > Guides. */
      agent: Schema.optionalKey(AgentSelection),
      targets: Schema.NonEmptyArray(FixTarget),
      note: Schema.NullOr(Schema.String),
      replyAfterPush: Schema.Boolean,
    }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersResolveConflicts, {
    payload: Schema.Struct({
      key: PullRequestKey,
      accountId: AccountId,
      agent: Schema.optionalKey(AgentSelection),
      strategy: ConflictStrategy,
    }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersPush, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersDiscard, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersRetry, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError, FixerWorkRefused]),
  }),
  Rpc.make(WS_METHODS.fixersRevert, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersRevise, {
    payload: Schema.Struct({
      key: PullRequestKey,
      turnId: FixerTurnId,
      note: Schema.NonEmptyString,
    }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersStop, {
    payload: Schema.Struct({ key: PullRequestKey }),
    success: FixerSnapshot,
    error: Schema.Union([FixerError, FixerStateError]),
  }),
  Rpc.make(WS_METHODS.fixersDiff, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: FixerDiff,
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixersPatch, {
    payload: Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId }),
    success: Schema.Struct({ patch: Schema.String }),
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixersPushAccess, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: PushAccess,
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixersScriptAccess, {
    payload: Schema.Struct({ key: PullRequestKey, accountId: AccountId }),
    success: ScriptAccess,
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixerSettingsList, {
    payload: Schema.Struct({}),
    success: Schema.Array(RepositoryFixerSettings),
    error: FixerError,
  }),
  Rpc.make(WS_METHODS.fixerSettingsUpdate, {
    payload: Schema.Struct({
      repository: Schema.NonEmptyString,
      pushAutomatically: Schema.optionalKey(Schema.Boolean),
      resolveAutomatically: Schema.optionalKey(Schema.Boolean),
      runScriptsOnAnyPullRequest: Schema.optionalKey(Schema.Boolean),
    }),
    success: RepositoryFixerSettings,
    error: FixerError,
  }),
  // Outside agents (docs/features/outside-agents.md).
  Rpc.make(WS_METHODS.outsideAgentsGet, {
    payload: Schema.Struct({}),
    success: OutsideAgentsState,
    error: OutsideAgentsError,
  }),
  Rpc.make(WS_METHODS.outsideAgentsUpdate, {
    payload: Schema.Struct({ enabled: Schema.Boolean, access: OutsideAccess }),
    success: OutsideAgentsState,
    error: OutsideAgentsError,
  }),
  // A new token; every connected client is dropped and must read the new one.
  Rpc.make(WS_METHODS.outsideAgentsReset, {
    payload: Schema.Struct({}),
    success: OutsideAgentsState,
    error: OutsideAgentsError,
  }),
  Rpc.make(WS_METHODS.cliInstallGet, {
    payload: Schema.Struct({}),
    success: CliInstallState,
    error: CliInstallError,
  }),
  Rpc.make(WS_METHODS.cliInstall, {
    payload: Schema.Struct({}),
    success: CliInstallState,
    error: CliInstallError,
  }),
  Rpc.make(WS_METHODS.cliUninstall, {
    payload: Schema.Struct({}),
    success: CliInstallState,
    error: CliInstallError,
  }),
  Rpc.make(WS_METHODS.cliSkillInstall, {
    payload: Schema.Struct({}),
    success: Schema.Void,
    error: CliInstallError,
  }),
);
