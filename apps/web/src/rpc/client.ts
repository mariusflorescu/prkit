import type { CliInstallState } from "@prkit/contracts";
/**
 * The only module in the web app that builds or runs Effects. It owns the RPC
 * client over `/ws` and hands the rest of the UI plain promise functions.
 */
import {
  type AppInfo,
  type AppearanceChange,
  type AppearanceSettings,
  type AccountsResult,
  type GitHubBudget,
  type GitHubEvent,
  type InboxRead,
  type InboxResult,
  type RepositoryList,
  type RepositoryListRead,
  type RepositoryPullRequests,
  type AccountId,
  type PullRequestKey,
  type PullRequestDetail,
  type PullRequestCommand,
  type PullRequestFiles,
  type DiffSource,
  type DiffTexts,
  type PullRequestStack,
  type PullRequestTimeline,
  type InboxFilters,
  type Workspace,
  type WorkspaceChange,
  type WorkspaceCommand,
  type OutsideAgentsSettings,
  type OutsideAgentsState,
  type AgentCatalog,
  type AgentInstanceConfig,
  type AgentInstanceId,
  type AgentSelection,
  type CursorSdkInstallProgress,
  type AttemptId,
  type DiffSnapshot,
  type DraftGuideResult,
  type FileContents,
  type FileSide,
  type GuideRevision,
  type GuideSettings,
  type GuidanceEdit,
  type GuideConfigSave,
  type GuideRepository,
  type GuideScope,
  type PullRequestGuideConfig,
  type ScopeConfig,
  type ReviewError,
  type ReviewFeedEvent,
  type ReviewKey,
  type LocalGenerateResult,
  type LocalReviewEntry,
  type LocalReviewFeedEvent,
  type LocalReviewKey,
  type LocalReviewSnapshot,
  type LocalReviewWatchEvent,
  type ReviewSnapshot,
  type StackGuidesResult,
  type ReviewWatchEvent,
  type ReviewedDecision,
  type ReviewedFilesChange,
  type ReviewedMarks,
  type ManualCheckDecision,
  type ManualCheckTicks,
  type ManualCheckTicksChange,
  type ReviewSubject,
  type CommentPlacement,
  type NoteRef,
  type PendingComments,
  type ReviewCommentId,
  type ReviewEvent,
  type ReviewSubmitted,
  type ReviewThreads,
  type TypicalDuration,
  type ConflictStrategy,
  type FixerDiff,
  type FixerFeedEvent,
  type FixerSnapshot,
  type FixerTurnId,
  type FixTarget,
  type PushAccess,
  type RepositoryFixerSettings,
  type ScriptAccess,
  type AskInput,
  type AskWatchEvent,
  type Question,
  type QuestionId,
  type ReviewId,
  WS_METHODS,
  WsRpcGroup,
} from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { readSessionToken } from "./sessionToken.ts";

export class MissingSessionTokenError extends Schema.TaggedError<MissingSessionTokenError>()(
  "MissingSessionTokenError",
  {},
) {
  override get message(): string {
    return "This window has no session token. Reopen prkit from the desktop app or from the URL the dev runner printed.";
  }
}

export class ServerUnreachableError extends Schema.TaggedError<ServerUnreachableError>()(
  "ServerUnreachableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Can't reach the prkit server. Make sure it is running, then try again.";
  }
}

class WsClient extends Context.Service<
  WsClient,
  RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError.RpcClientError>
>()("@prkit/web/rpc/client/WsClient") {}

const CALL_TIMEOUT = "45 seconds";

const socketUrl = (token: string): string => {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};

const layerWsClient = (token: string) =>
  Layer.effect(WsClient, RpcClient.make(WsRpcGroup)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({ pingInterval: "5 seconds", pingTimeout: "15 seconds" }),
    ),
    Layer.provide(Socket.layerWebSocket(socketUrl(token))),
    Layer.provide(
      Layer.mergeAll(Socket.layerWebSocketConstructorGlobal, RpcSerialization.layerJson),
    ),
  );

let runtime: ManagedRuntime.ManagedRuntime<WsClient, never> | undefined;

const getRuntime = (): ManagedRuntime.ManagedRuntime<WsClient, never> | null => {
  if (runtime) return runtime;
  const token = readSessionToken();
  if (token === null) return null;
  runtime = ManagedRuntime.make(layerWsClient(token));
  return runtime;
};

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

const call = <A, E>(
  use: (client: WsClient["Service"]) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
  timeout: Duration.Input = CALL_TIMEOUT,
): Promise<A> => {
  const current = getRuntime();
  if (current === null) return Promise.reject(new MissingSessionTokenError());
  // Only transport failures become ServerUnreachableError. Typed errors a handler
  // declares reach TanStack Query as they are, so the UI can explain them.
  return current.runPromise(
    WsClient.use(use).pipe(
      Effect.timeout(timeout),
      Effect.catchIf(
        (error): error is RpcClientError.RpcClientError | Cause.TimeoutError =>
          isRpcClientError(error) || Cause.isTimeoutError(error),
        (cause) => Effect.fail(new ServerUnreachableError({ cause })),
      ),
    ),
  );
};

export const getAppInfo = (): Promise<AppInfo> => call((client) => client[WS_METHODS.appInfo]({}));
export const listAccounts = (): Promise<AccountsResult> =>
  call((client) => client[WS_METHODS.accountsList]({}));
export const refreshAccounts = (): Promise<AccountsResult> =>
  call((client) => client[WS_METHODS.accountsRefresh]({}));
export const addConfigDir = (path: string): Promise<AccountsResult> =>
  call((client) => client[WS_METHODS.accountsAddConfigDir]({ path }));
export const removeConfigDir = (path: string): Promise<AccountsResult> =>
  call((client) => client[WS_METHODS.accountsRemoveConfigDir]({ path }));
export const listInbox = (read: InboxRead): Promise<InboxResult> =>
  call((client) => client[WS_METHODS.inboxList]({ read }));
export const listRepositories = (
  read: RepositoryListRead = { _tag: "cached" },
): Promise<RepositoryList> => call((client) => client[WS_METHODS.repositoriesList]({ read }));
export const listRepositoryPullRequests = (input: {
  accountId: AccountId;
  host: string;
  owner: string;
  name: string;
}): Promise<RepositoryPullRequests> =>
  call((client) => client[WS_METHODS.repositoriesPullRequests](input));
export const getGitHubBudget = (): Promise<GitHubBudget> =>
  call((client) => client[WS_METHODS.githubBudget]({}));
export const getWorkspace = (): Promise<Workspace> =>
  call((client) => client[WS_METHODS.workspaceGet]({}));
export const saveInboxFilters = (filters: InboxFilters): Promise<Workspace> =>
  call((client) => client[WS_METHODS.workspaceSaveInboxFilters](filters));
/** Hears the open tabs on every (re)subscription, then each change made elsewhere, until the returned function is called. */
export const watchWorkspace = (onChange: (change: WorkspaceChange) => void): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.workspaceChanges]({}).pipe(
        Stream.runForEach((change) => Effect.sync(() => onChange(change))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};
export const changeWorkspace = (command: WorkspaceCommand): Promise<Workspace> => {
  switch (command.kind) {
    case "open":
      return call((client) =>
        client[WS_METHODS.workspaceOpen]({ key: command.key, accountId: command.accountId }),
      );
    case "close":
      return call((client) => client[WS_METHODS.workspaceClose]({ key: command.key }));
    case "activate":
      return call((client) => client[WS_METHODS.workspaceActivate]({ key: command.key }));
    case "reorder":
      return call((client) => client[WS_METHODS.workspaceReorder]({ keys: command.keys }));
    case "open-local":
      return call((client) => client[WS_METHODS.workspaceOpenLocal]({ key: command.key }));
    case "close-local":
      return call((client) => client[WS_METHODS.workspaceCloseLocal]({ key: command.key }));
    case "remove-damaged":
      return call((client) => client[WS_METHODS.workspaceRemoveDamaged]({ keys: command.keys }));
  }
};
export const getPullRequestDetail = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PullRequestDetail> =>
  call((client) => client[WS_METHODS.pullRequestsDetail]({ key, accountId }));
/** The stack the PR is a layer of, bottom to top; null when it isn't in one. */
export const getPullRequestStack = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PullRequestStack | null> =>
  call((client) => client[WS_METHODS.pullRequestsStack]({ key, accountId }));
/** Marks the PR's cached reads stale on the server, so the next reads go to GitHub. */
export const refreshPullRequest = (key: PullRequestKey, accountId: AccountId): Promise<void> =>
  call((client) => client[WS_METHODS.pullRequestsRefresh]({ key, accountId }));

export const getPullRequestFiles = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PullRequestFiles> =>
  call((client) => client[WS_METHODS.pullRequestsFiles]({ key, accountId }));
export const executePullRequest = (
  key: PullRequestKey,
  accountId: AccountId,
  command: PullRequestCommand,
) => call((client) => client[WS_METHODS.pullRequestsExecute]({ key, accountId, command }));
export const getPullRequestCandidates = (key: PullRequestKey, accountId: AccountId) =>
  call((client) => client[WS_METHODS.pullRequestsCandidates]({ key, accountId }));
export const getPullRequestTimeline = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PullRequestTimeline> =>
  call((client) => client[WS_METHODS.pullRequestsTimeline]({ key, accountId }));

// The files the user marked reviewed.
export const getReviewedFiles = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<ReviewedMarks> =>
  call((client) => client[WS_METHODS.reviewedFilesGet]({ key, accountId }));
export const setReviewedFiles = (
  key: PullRequestKey,
  accountId: AccountId,
  decision: ReviewedDecision,
): Promise<ReviewedMarks> =>
  call((client) => client[WS_METHODS.reviewedFilesSet]({ key, accountId, decision }));
/** Hears reviewed files saved anywhere, an outside agent included, until the returned function is called. */
export const watchReviewedFiles = (
  onChange: (change: ReviewedFilesChange) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.reviewedFilesChanges]({}).pipe(
        Stream.runForEach((change) => Effect.sync(() => onChange(change))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

// The manual check steps the user ticked.
export const getManualCheckTicks = (subject: ReviewSubject): Promise<ManualCheckTicks> =>
  call((client) => client[WS_METHODS.manualCheckTicksGet]({ subject }));
export const setManualCheckTicks = (
  subject: ReviewSubject,
  decision: ManualCheckDecision,
): Promise<ManualCheckTicks> =>
  call((client) => client[WS_METHODS.manualCheckTicksSet]({ subject, decision }));
/** Hears ticks saved anywhere, an outside agent included, until the returned function is called. */
export const watchManualCheckTicks = (
  onChange: (change: ManualCheckTicksChange) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.manualCheckTicksChanges]({}).pipe(
        Stream.runForEach((change) => Effect.sync(() => onChange(change))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

// Reviews, guides and agents.
export const getReview = (key: PullRequestKey): Promise<ReviewSnapshot> =>
  call((client) => client[WS_METHODS.reviewsGet]({ key }));
/** Without `agent`, the server uses the review's own agent or the default in Settings > Guides. */
export const generateReview = (
  key: PullRequestKey,
  accountId: AccountId,
  input: { readonly agent?: AgentSelection; readonly guidance?: GuidanceEdit } = {},
): Promise<ReviewSnapshot> =>
  call((client) => client[WS_METHODS.reviewsGenerate]({ key, accountId, ...input }));
/** One guide for each chosen layer of the stack `key` is in, with one agent. */
export const generateStackGuides = (input: {
  readonly key: PullRequestKey;
  readonly accountId: AccountId;
  readonly layers: readonly [number, ...number[]];
  readonly regenerate: boolean;
  readonly agent?: AgentSelection;
  readonly guidance?: GuidanceEdit;
}): Promise<StackGuidesResult> => call((client) => client[WS_METHODS.reviewsGenerateStack](input));
export const stopReview = (key: PullRequestKey): Promise<ReviewSnapshot> =>
  call((client) => client[WS_METHODS.reviewsStop]({ key }));
export const retryReview = (key: PullRequestKey): Promise<ReviewSnapshot> =>
  call((client) => client[WS_METHODS.reviewsRetry]({ key }));
export const getGuide = (key: ReviewKey, revision: number): Promise<GuideRevision> =>
  call((client) => client[WS_METHODS.guidesGet]({ key, revision }));
export const getDraft = (key: ReviewKey, attemptId: AttemptId): Promise<DraftGuideResult> =>
  call((client) => client[WS_METHODS.guidesDraft]({ key, attemptId }));
export const getAttemptDiff = (key: ReviewKey, attemptId: AttemptId): Promise<DiffSnapshot> =>
  call((client) => client[WS_METHODS.reviewsDiff]({ key, attemptId }));
export const getTypicalDuration = (
  instance: AgentInstanceId,
  lines: number,
): Promise<TypicalDuration | null> =>
  call((client) => client[WS_METHODS.reviewsTypicalDuration]({ instance, lines }));
/** `refresh` reads logins again: every instance's, or only `instance`'s. */
export const getAgentCatalog = (
  refresh = false,
  instance?: AgentInstanceId,
): Promise<AgentCatalog> =>
  call((client) =>
    client[WS_METHODS.agentsCatalog](instance === undefined ? { refresh } : { refresh, instance }),
  );
export const createAgentInstance = (config: AgentInstanceConfig): Promise<AgentCatalog> =>
  call((client) => client[WS_METHODS.agentsCreate]({ config }));
/** A sensitive variable sent back empty and redacted keeps the value the server holds. */
export const updateAgentInstance = (config: AgentInstanceConfig): Promise<AgentCatalog> =>
  call((client) => client[WS_METHODS.agentsUpdate]({ config }));
export const removeAgentInstance = (instance: AgentInstanceId): Promise<AgentCatalog> =>
  call((client) => client[WS_METHODS.agentsRemove]({ instance }));
export const resetAgentInstance = (instance: AgentInstanceId): Promise<AgentCatalog> =>
  call((client) => client[WS_METHODS.agentsReset]({ instance }));
/**
 * Signs an agent in for prkit: `onPage` gets the page to sign in on, and the promise settles
 * once that sign-in ends, with "cancelled" when `signal` stopped it. Failures reject the way
 * `call`'s do.
 */
export const signInAgent = (
  instance: AgentInstanceId,
  onPage: (url: string) => void,
  signal: AbortSignal,
): Promise<"signed-in" | "cancelled"> => {
  const current = getRuntime();
  if (current === null) return Promise.reject(new MissingSessionTokenError());
  const cancelled = Effect.callback<"cancelled">((resume) => {
    const onAbort = () => resume(Effect.succeed("cancelled"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return current.runPromise(
    WsClient.use((client) =>
      client[WS_METHODS.agentsSignIn]({ instance }).pipe(
        Stream.runForEach((page) => Effect.sync(() => onPage(page.url))),
      ),
    ).pipe(
      Effect.as("signed-in" as const),
      Effect.catchIf(isRpcClientError, (cause) =>
        Effect.fail(new ServerUnreachableError({ cause })),
      ),
      Effect.raceFirst(cancelled),
    ),
  );
};
/** Downloads and checks Cursor's SDK on the user's request, telling each package as it starts. */
export const installCursor = (
  onProgress: (progress: CursorSdkInstallProgress) => void,
): Promise<void> => {
  const current = getRuntime();
  if (current === null) return Promise.reject(new MissingSessionTokenError());
  return current.runPromise(
    WsClient.use((client) =>
      client[WS_METHODS.agentsInstallCursor]({}).pipe(
        Stream.runForEach((progress) => Effect.sync(() => onProgress(progress))),
      ),
    ).pipe(
      Effect.catchIf(isRpcClientError, (cause) =>
        Effect.fail(new ServerUnreachableError({ cause })),
      ),
    ),
  );
};
export const signOutAgent = (instance: AgentInstanceId): Promise<AgentCatalog> =>
  call((client) => client[WS_METHODS.agentsSignOut]({ instance }));
export const getGuideSettings = (): Promise<GuideSettings> =>
  call((client) => client[WS_METHODS.guideSettingsGet]({}));
export const updateGuideSettings = (patch: {
  readonly defaultAgent?: GuideSettings["defaultAgent"];
  readonly autoAccounts?: GuideSettings["autoAccounts"];
}): Promise<GuideSettings> => call((client) => client[WS_METHODS.guideSettingsUpdate](patch));
export const getAppearance = (): Promise<AppearanceSettings> =>
  call((client) => client[WS_METHODS.appearanceGet]({}));
export const updateAppearance = (change: AppearanceChange): Promise<AppearanceSettings> =>
  call((client) => client[WS_METHODS.appearanceUpdate](change));
// Outside agents (docs/features/outside-agents.md).
export const getOutsideAgents = (): Promise<OutsideAgentsState> =>
  call((client) => client[WS_METHODS.outsideAgentsGet]({}));
export const updateOutsideAgents = (settings: OutsideAgentsSettings): Promise<OutsideAgentsState> =>
  call((client) => client[WS_METHODS.outsideAgentsUpdate](settings));
export const resetOutsideAgents = (): Promise<OutsideAgentsState> =>
  call((client) => client[WS_METHODS.outsideAgentsReset]({}));
// Guide settings (docs/internals/architecture.md "Guide settings").
export const getGuideScope = (scope: GuideScope): Promise<ScopeConfig> =>
  call((client) => client[WS_METHODS.guideConfigScope]({ scope }));
export const getPullRequestGuideConfig = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PullRequestGuideConfig> =>
  call((client) => client[WS_METHODS.guideConfigPullRequest]({ key, accountId }));
export const listGuideRepositories = (): Promise<ReadonlyArray<GuideRepository>> =>
  call((client) => client[WS_METHODS.guideConfigRepositories]({}));
export const findGuideRepository = (input: {
  readonly accountId: AccountId;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}): Promise<GuideRepository> =>
  call((client) => client[WS_METHODS.guideConfigFindRepository](input));
export const saveGuideConfig = (input: GuideConfigSave): Promise<ScopeConfig> =>
  call((client) => client[WS_METHODS.guideConfigSave](input));
export const getFileContents = (
  key: PullRequestKey,
  accountId: AccountId,
  path: string,
  side: FileSide,
): Promise<FileContents> =>
  call((client) => client[WS_METHODS.pullRequestsFileContents]({ key, accountId, path, side }));

export const getDiffTexts = (
  source: DiffSource,
  paths: ReadonlyArray<string>,
): Promise<DiffTexts> => call((client) => client[WS_METHODS.diffsTexts]({ source, paths }));

// Pending review comments and GitHub review threads, always through the PR's account.
export const listPendingComments = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<PendingComments> =>
  call((client) => client[WS_METHODS.reviewCommentsList]({ key, accountId }));
export const addPendingComment = (input: {
  key: PullRequestKey;
  accountId: AccountId;
  placement: CommentPlacement;
  body: string;
}): Promise<PendingComments> => call((client) => client[WS_METHODS.reviewCommentsAdd](input));
export const addNoteComment = (input: {
  key: PullRequestKey;
  accountId: AccountId;
  note: NoteRef;
  body: string;
}): Promise<PendingComments> =>
  call((client) => client[WS_METHODS.reviewCommentsAddFromNote](input));
export const editPendingComment = (id: ReviewCommentId, body: string): Promise<PendingComments> =>
  call((client) => client[WS_METHODS.reviewCommentsEdit]({ id, body }));
export const movePendingComment = (
  id: ReviewCommentId,
  placement: CommentPlacement,
): Promise<PendingComments> =>
  call((client) => client[WS_METHODS.reviewCommentsMove]({ id, placement }));
export const deletePendingComment = (id: ReviewCommentId): Promise<PendingComments> =>
  call((client) => client[WS_METHODS.reviewCommentsDelete]({ id }));
export const submitReview = (input: {
  key: PullRequestKey;
  accountId: AccountId;
  event: ReviewEvent;
  body: string;
}): Promise<ReviewSubmitted> => call((client) => client[WS_METHODS.reviewCommentsSubmit](input));
export const listReviewThreads = (
  key: PullRequestKey,
  accountId: AccountId,
): Promise<ReviewThreads> =>
  call((client) => client[WS_METHODS.reviewThreadsList]({ key, accountId }));
export const replyToThread = (input: {
  key: PullRequestKey;
  accountId: AccountId;
  threadId: string;
  body: string;
}): Promise<ReviewThreads> => call((client) => client[WS_METHODS.reviewThreadsReply](input));
export const resolveThread = (input: {
  key: PullRequestKey;
  accountId: AccountId;
  threadId: string;
  resolved: boolean;
}): Promise<ReviewThreads> => call((client) => client[WS_METHODS.reviewThreadsResolve](input));

/**
 * Follows a review's status and activity until the returned function is called.
 * Every subscription opens with a full snapshot, so after a dropped connection the
 * resubscribe replaces whatever the caller had before later updates apply.
 */
export const watchReview = (
  key: PullRequestKey,
  onEvent: (event: ReviewWatchEvent) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.reviewsWatch]({ key }).pipe(
        Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

/**
 * Follows a review's questions until the returned function is called. Every subscription
 * opens with a snapshot, so a resubscribe after a failure replaces what the caller had.
 * `onError` hears each failure, in words for the user, before the next try.
 */
export const watchAsks = (
  reviewId: ReviewId,
  onEvent: (event: AskWatchEvent) => void,
  onError: (message: string) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) {
    onError(new MissingSessionTokenError().message);
    return () => {};
  }
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.asksWatch]({ reviewId }).pipe(
        Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
      ),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          onError(
            isRpcClientError(error)
              ? new ServerUnreachableError({ cause: error }).message
              : error.message,
          ),
        ),
      ),
      Effect.ignore,
      Effect.andThen(Effect.sleep("2 seconds")),
      Effect.forever,
    ),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};
/** Stores the question and returns at once; its answer arrives on `watchAsks`. */
export const askQuestion = (input: AskInput): Promise<Question> =>
  call((client) => client[WS_METHODS.asksAsk](input));
export const stopQuestion = (questionId: QuestionId): Promise<Question> =>
  call((client) => client[WS_METHODS.asksStop]({ questionId }));
export const retryQuestion = (questionId: QuestionId): Promise<Question> =>
  call((client) => client[WS_METHODS.asksRetry]({ questionId }));
export const pinAnswer = (questionId: QuestionId, pinned: boolean): Promise<Question> =>
  call((client) => client[WS_METHODS.asksPin]({ questionId, pinned }));
export const removeDamagedQuestions = (
  reviewId: ReviewId,
  questionIds: ReadonlyArray<QuestionId>,
): Promise<void> =>
  call((client) => client[WS_METHODS.asksRemoveDamaged]({ reviewId, questionIds }));

/**
 * Hears what changed on the server's GitHub caches until the returned function is
 * called. The server fingerprints open PR tabs only while a window holds this open.
 */
export const watchGitHub = (onEvent: (event: GitHubEvent) => void): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.githubEvents]({}).pipe(
        Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

/**
 * Follows one of prkit's review streams until `stop`. When prkit can't read what it follows
 * (`ReviewError`), `onFailed` gets its message and it tries again after 2 seconds, then less
 * often, up to a minute apart, or at once on `retry`: right after a try under way, or now while
 * it waits. A dropped connection only tries again.
 */
const followReviews = <A>(
  subscribe: (
    client: WsClient["Service"],
  ) => Stream.Stream<A, ReviewError | RpcClientError.RpcClientError>,
  onEvent: (event: A) => void,
  onFailed: (message: string) => void,
) => {
  const current = getRuntime();
  if (current === null) return { stop: () => {}, retry: () => {} };
  let failures = 0;
  let wake: (() => void) | null = null;
  let skipWait = false;
  const follow = WsClient.use((client) =>
    subscribe(client).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          failures = 0;
          onEvent(event);
        }),
      ),
    ),
  ).pipe(
    Effect.catchTag("ReviewError", (error) =>
      Effect.sync(() => {
        failures += 1;
        onFailed(error.message);
      }),
    ),
    Effect.ignore,
  );
  const wait = Effect.gen(function* () {
    if (skipWait) {
      skipWait = false;
      return;
    }
    const woken = yield* Deferred.make<void>();
    wake = () => current.runFork(Deferred.succeed(woken, undefined));
    yield* Effect.race(
      Effect.sleep(Math.min(2_000 * 2 ** Math.max(0, failures - 1), 60_000)),
      Deferred.await(woken),
    );
    wake = null;
  });
  const fiber = current.runFork(follow.pipe(Effect.andThen(wait), Effect.forever));
  return {
    stop: () => {
      current.runFork(Fiber.interrupt(fiber));
    },
    retry: () => {
      if (wake === null) skipWait = true;
      else wake();
    },
  };
};

/** Asks the review feed being followed to try again now; set while `watchReviewFeed` runs. */
let retryFeed: (() => void) | null = null;

/**
 * Follows every review app-wide (inbox marks, tab indicators, notifications) until the
 * returned function is called, as `followReviews` does. Each subscription opens with the full
 * index. `retryReviewFeed` tries again now.
 */
export const watchReviewFeed = (
  onEvent: (event: ReviewFeedEvent) => void,
  onFailed: (message: string) => void,
): (() => void) => {
  const feed = followReviews((client) => client[WS_METHODS.reviewsFeed]({}), onEvent, onFailed);
  retryFeed = feed.retry;
  return () => {
    retryFeed = null;
    feed.stop();
  };
};
/** Tries the review feed again now: at once while it waits, or right after a try under way. */
export const retryReviewFeed = () => retryFeed?.();

// Guides of local changes: no account, and nothing reaches GitHub.
export const listLocalReviews = (): Promise<ReadonlyArray<LocalReviewEntry>> =>
  call((client) => client[WS_METHODS.localReviewsList]({}));
export const getLocalReview = (key: LocalReviewKey): Promise<LocalReviewSnapshot> =>
  call((client) => client[WS_METHODS.localReviewsGet]({ key }));
/** Run again: a new snapshot of the folder, which can take a while for a large working tree. */
export const generateLocalReview = (
  key: LocalReviewKey,
  input: { readonly agent?: AgentSelection; readonly regenerate?: boolean } = {},
): Promise<LocalGenerateResult> =>
  call((client) => client[WS_METHODS.localReviewsGenerate]({ key, ...input }), "3 minutes");
export const stopLocalReview = (key: LocalReviewKey): Promise<LocalReviewSnapshot> =>
  call((client) => client[WS_METHODS.localReviewsStop]({ key }));
export const retryLocalReview = (key: LocalReviewKey): Promise<LocalReviewSnapshot> =>
  call((client) => client[WS_METHODS.localReviewsRetry]({ key }));
export const removeLocalReview = (key: LocalReviewKey): Promise<void> =>
  call((client) => client[WS_METHODS.localReviewsRemove]({ key }).pipe(Effect.asVoid));
export const getLocalFileContents = (
  key: LocalReviewKey,
  revision: number,
  path: string,
  side: FileSide,
): Promise<FileContents> =>
  call((client) => client[WS_METHODS.localReviewsFileContents]({ key, revision, path, side }));
/**
 * Like `watchReview`: a snapshot first on every subscription, then updates, then `removed`,
 * followed as `followReviews` does.
 */
export const watchLocalReview = (
  key: LocalReviewKey,
  onEvent: (event: LocalReviewWatchEvent) => void,
  onFailed: (message: string) => void,
) => followReviews((client) => client[WS_METHODS.localReviewsWatch]({ key }), onEvent, onFailed);
/** Every local review for the whole app, opening with the full index on each subscription. */
export const watchLocalReviewFeed = (
  onEvent: (event: LocalReviewFeedEvent) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.localReviewsFeed]({}).pipe(
        Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

// The fix agent: review fixes and merge conflicts, always through the PR's account.
export const getFixer = (key: PullRequestKey): Promise<FixerSnapshot> =>
  call((client) => client[WS_METHODS.fixersGet]({ key }));
/** Without `agent`, the server uses the session's own agent or the default in Settings > Agents. */
export const sendToAgent = (input: {
  readonly key: PullRequestKey;
  readonly accountId: AccountId;
  readonly agent?: AgentSelection;
  readonly targets: readonly [FixTarget, ...FixTarget[]];
  readonly note: string | null;
  readonly replyAfterPush: boolean;
}): Promise<FixerSnapshot> => call((client) => client[WS_METHODS.fixersSend](input));
export const resolveConflicts = (input: {
  readonly key: PullRequestKey;
  readonly accountId: AccountId;
  readonly agent?: AgentSelection;
  readonly strategy: ConflictStrategy;
}): Promise<FixerSnapshot> => call((client) => client[WS_METHODS.fixersResolveConflicts](input));
const turnCommands = {
  push: WS_METHODS.fixersPush,
  discard: WS_METHODS.fixersDiscard,
  retry: WS_METHODS.fixersRetry,
  revert: WS_METHODS.fixersRevert,
} as const;
export const runTurnCommand = (
  command: keyof typeof turnCommands,
  key: PullRequestKey,
  turnId: FixerTurnId,
): Promise<FixerSnapshot> => {
  switch (command) {
    case "push":
      return call((client) => client[turnCommands.push]({ key, turnId }));
    case "discard":
      return call((client) => client[turnCommands.discard]({ key, turnId }));
    case "retry":
      return call((client) => client[turnCommands.retry]({ key, turnId }));
    case "revert":
      return call((client) => client[turnCommands.revert]({ key, turnId }));
  }
};
export const reviseFix = (
  key: PullRequestKey,
  turnId: FixerTurnId,
  note: string,
): Promise<FixerSnapshot> =>
  call((client) => client[WS_METHODS.fixersRevise]({ key, turnId, note }));
export const stopFixer = (key: PullRequestKey): Promise<FixerSnapshot> =>
  call((client) => client[WS_METHODS.fixersStop]({ key }));
export const getFixerDiff = (key: PullRequestKey, turnId: FixerTurnId): Promise<FixerDiff> =>
  call((client) => client[WS_METHODS.fixersDiff]({ key, turnId }));
export const getFixerPatch = (key: PullRequestKey, turnId: FixerTurnId): Promise<string> =>
  call((client) => client[WS_METHODS.fixersPatch]({ key, turnId })).then((result) => result.patch);
export const getPushAccess = (key: PullRequestKey, accountId: AccountId): Promise<PushAccess> =>
  call((client) => client[WS_METHODS.fixersPushAccess]({ key, accountId }));
export const getScriptAccess = (key: PullRequestKey, accountId: AccountId): Promise<ScriptAccess> =>
  call((client) => client[WS_METHODS.fixersScriptAccess]({ key, accountId }));
export const listFixerSettings = (): Promise<ReadonlyArray<RepositoryFixerSettings>> =>
  call((client) => client[WS_METHODS.fixerSettingsList]({}));
export const updateFixerSettings = (patch: {
  readonly repository: string;
  readonly pushAutomatically?: boolean;
  readonly resolveAutomatically?: boolean;
  readonly runScriptsOnAnyPullRequest?: boolean;
}): Promise<RepositoryFixerSettings> =>
  call((client) => client[WS_METHODS.fixerSettingsUpdate](patch));

/** Follows one PR's fix session until the returned function is called; each subscription opens with a snapshot. */
export const watchFixer = (
  key: PullRequestKey,
  onSnapshot: (snapshot: FixerSnapshot) => void,
): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.fixersWatch]({ key }).pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => onSnapshot(snapshot))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

/** Follows every PR's fix session app-wide (tab marks, notices) until the returned function is called. */
export const watchFixerFeed = (onEvent: (event: FixerFeedEvent) => void): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.fixersFeed]({}).pipe(
        Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
      ),
    ).pipe(Effect.ignore, Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
  );
  return () => {
    current.runFork(Fiber.interrupt(fiber));
  };
};

export const getCliInstall = (): Promise<CliInstallState> =>
  call((client) => client[WS_METHODS.cliInstallGet]({}));
export const installCli = (): Promise<CliInstallState> =>
  call((client) => client[WS_METHODS.cliInstall]({}));
export const uninstallCli = (): Promise<CliInstallState> =>
  call((client) => client[WS_METHODS.cliUninstall]({}));
export const installCliSkill = (): Promise<void> =>
  call((client) => client[WS_METHODS.cliSkillInstall]({}));
