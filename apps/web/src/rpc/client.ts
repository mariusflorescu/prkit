/**
 * The only module in the web app that builds or runs Effects. It owns the RPC
 * client over `/ws` and hands the rest of the UI plain promise functions.
 */
import {
  type AppInfo,
  type AppearanceSettings,
  type ThemePreference,
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
  type PullRequestStack,
  type PullRequestTimeline,
  type InboxFilters,
  type SavedInboxFilters,
  type Workspace,
  type WorkspaceCommand,
  type AgentCatalog,
  type AgentInstanceConfig,
  type AgentInstanceId,
  type AgentSelection,
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
  type ReviewFeedEvent,
  type ReviewSnapshot,
  type StackGuidesResult,
  type ReviewWatchEvent,
  type CommentPlacement,
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
  WS_METHODS,
  WsRpcGroup,
} from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
): Promise<A> => {
  const current = getRuntime();
  if (current === null) return Promise.reject(new MissingSessionTokenError());
  // Only transport failures become ServerUnreachableError. Typed errors a handler
  // declares reach TanStack Query as they are, so the UI can explain them.
  return current.runPromise(
    WsClient.use(use).pipe(
      Effect.timeout(CALL_TIMEOUT),
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
export const listInbox = (read: InboxRead = { _tag: "cached" }): Promise<InboxResult> =>
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
export const saveInboxFilters = (filters: InboxFilters): Promise<SavedInboxFilters> =>
  call((client) => client[WS_METHODS.workspaceSaveInboxFilters](filters));
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
export const getGuide = (key: PullRequestKey, revision: number): Promise<GuideRevision> =>
  call((client) => client[WS_METHODS.guidesGet]({ key, revision }));
export const getDraft = (key: PullRequestKey, attemptId: AttemptId): Promise<DraftGuideResult> =>
  call((client) => client[WS_METHODS.guidesDraft]({ key, attemptId }));
export const getAttemptDiff = (key: PullRequestKey, attemptId: AttemptId): Promise<DiffSnapshot> =>
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
export const updateAppearance = (theme: ThemePreference): Promise<AppearanceSettings> =>
  call((client) => client[WS_METHODS.appearanceUpdate]({ theme }));
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
 * Follows every review app-wide (inbox marks, tab indicators, notifications) until
 * the returned function is called. Each subscription opens with the full index.
 */
export const watchReviewFeed = (onEvent: (event: ReviewFeedEvent) => void): (() => void) => {
  const current = getRuntime();
  if (current === null) return () => {};
  const fiber = current.runFork(
    WsClient.use((client) =>
      client[WS_METHODS.reviewsFeed]({}).pipe(
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
