// @effect-diagnostics-next-line nodeBuiltinImport:off -- effect/Crypto has no constant-time compare.
import * as NodeCrypto from "node:crypto";

import { WS_METHODS, WsRpcGroup } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as ServerConfig from "./config.ts";
import { GitHubAccounts } from "./accounts/GitHubAccounts.ts";
import { GitHubApi } from "./github/GitHubApi.ts";
import { PullRequests } from "./pullRequests/PullRequests.ts";
import { Workspace } from "./workspace/Workspace.ts";
import { Agents } from "./agents/Agents.ts";
import { CursorSdk } from "./agents/cursor/CursorSdk.ts";
import { AppearanceStore } from "./appearance/AppearanceStore.ts";
import { buildId } from "./build.ts";
import { GuideConfigStore } from "./reviews/GuideConfigStore.ts";
import { GuideSettingsStore } from "./reviews/GuideSettingsStore.ts";
import { Reviews } from "./reviews/Reviews.ts";
import { ReviewComments } from "./reviewComments/ReviewComments.ts";
import { Fixers } from "./fixers/Fixers.ts";
import { FixerSettingsStore } from "./fixers/FixerSettingsStore.ts";
import { boundPort } from "./listenAddress.ts";
import { CliInstall } from "./cli/CliInstall.ts";
import { OutsideAgents } from "./outside/OutsideAgents.ts";

export type UpgradeDecision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Reject"; readonly status: 401 | 403; readonly message: string };

/**
 * Any web page can try to open a socket to localhost, so `/ws` needs both the
 * per-launch token and an Origin this server trusts.
 */
export const decideUpgrade = (input: {
  readonly origin: string | undefined;
  readonly token: string | null;
  readonly expectedToken: Redacted.Redacted<string>;
  readonly allowedOrigins: ReadonlySet<string>;
}): UpgradeDecision => {
  if (input.token === null || !tokensMatch(input.token, Redacted.value(input.expectedToken))) {
    return { _tag: "Reject", status: 401, message: "Missing or invalid token" };
  }
  if (input.origin === undefined || !input.allowedOrigins.has(input.origin)) {
    return { _tag: "Reject", status: 403, message: "Origin not allowed" };
  }
  return { _tag: "Allow" };
};

/** Compares digests so the check takes the same time whatever the input length. */
const tokensMatch = (actual: string, expected: string): boolean =>
  NodeCrypto.timingSafeEqual(sha256(actual), sha256(expected));

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

const layerHandlers = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const accounts = yield* GitHubAccounts;
    const pullRequests = yield* PullRequests;
    const github = yield* GitHubApi;
    const workspace = yield* Workspace;
    const reviews = yield* Reviews;
    const agents = yield* Agents;
    const cursorSdk = yield* CursorSdk;
    const reviewComments = yield* ReviewComments;
    const guideSettings = yield* GuideSettingsStore;
    const fixers = yield* Fixers;
    const fixerSettings = yield* FixerSettingsStore;
    const appearance = yield* AppearanceStore;
    const guideConfig = yield* GuideConfigStore;
    const cliInstall = yield* CliInstall;
    const outsideAgents = yield* OutsideAgents;
    return WsRpcGroup.of({
      [WS_METHODS.accountsList]: () => accounts.list(),
      [WS_METHODS.accountsRefresh]: () => accounts.refresh(),
      [WS_METHODS.accountsAddConfigDir]: ({ path }) => accounts.addConfigDir(path),
      [WS_METHODS.accountsRemoveConfigDir]: ({ path }) => accounts.removeConfigDir(path),
      [WS_METHODS.inboxList]: ({ read }) => pullRequests.inbox(read),
      [WS_METHODS.repositoriesList]: ({ read }) => pullRequests.repositories(read),
      [WS_METHODS.repositoriesPullRequests]: ({ accountId, host, owner, name }) =>
        pullRequests.repositoryPullRequests(accountId, host, owner, name),
      [WS_METHODS.githubBudget]: () => github.budget,
      [WS_METHODS.githubEvents]: () => pullRequests.watch(),
      [WS_METHODS.pullRequestsDetail]: ({ key, accountId }) => pullRequests.detail(key, accountId),
      [WS_METHODS.pullRequestsStack]: ({ key, accountId }) => pullRequests.stack(key, accountId),
      [WS_METHODS.pullRequestsRefresh]: ({ key, accountId }) =>
        pullRequests.refresh(key, accountId),
      [WS_METHODS.pullRequestsFiles]: ({ key, accountId }) => pullRequests.files(key, accountId),
      [WS_METHODS.pullRequestsTimeline]: ({ key, accountId }) =>
        pullRequests.timeline(key, accountId),
      [WS_METHODS.pullRequestsFileContents]: ({ key, accountId, path, side }) =>
        pullRequests.fileContents(key, accountId, path, side),
      [WS_METHODS.pullRequestsExecute]: ({ key, accountId, command }) =>
        pullRequests.execute(key, accountId, command),
      [WS_METHODS.pullRequestsCandidates]: ({ key, accountId }) =>
        pullRequests.candidates(key, accountId),
      [WS_METHODS.workspaceGet]: () => workspace.get(),
      [WS_METHODS.workspaceOpen]: ({ key, accountId }) =>
        workspace.command({ kind: "open", key, accountId }),
      [WS_METHODS.workspaceClose]: ({ key }) => workspace.command({ kind: "close", key }),
      [WS_METHODS.workspaceActivate]: ({ key }) => workspace.command({ kind: "activate", key }),
      [WS_METHODS.workspaceReorder]: ({ keys }) => workspace.command({ kind: "reorder", keys }),
      [WS_METHODS.workspaceSaveInboxFilters]: (filters) => workspace.saveInboxFilters(filters),
      [WS_METHODS.workspaceChanges]: () => workspace.changes(),
      // Reviews, guides and agents.
      [WS_METHODS.reviewsGet]: ({ key }) => reviews.get(key),
      [WS_METHODS.reviewsGenerate]: ({ key, accountId, agent, guidance }) =>
        reviews.generate(key, accountId, {
          ...(agent === undefined ? {} : { agent }),
          ...(guidance === undefined ? {} : { guidance }),
        }),
      [WS_METHODS.reviewsGenerateStack]: ({
        key,
        accountId,
        layers,
        regenerate,
        agent,
        guidance,
      }) =>
        reviews.generateStack(key, accountId, {
          layers,
          regenerate,
          ...(agent === undefined ? {} : { agent }),
          ...(guidance === undefined ? {} : { guidance }),
        }),
      [WS_METHODS.reviewsStop]: ({ key }) => reviews.stop(key),
      [WS_METHODS.reviewsRetry]: ({ key }) => reviews.retry(key),
      [WS_METHODS.reviewsWatch]: ({ key }) => reviews.watch(key),
      [WS_METHODS.reviewsFeed]: () => reviews.feed(),
      [WS_METHODS.reviewsDiff]: ({ key, attemptId }) => reviews.diff(key, attemptId),
      [WS_METHODS.reviewsTypicalDuration]: ({ instance, lines }) =>
        reviews.typicalDuration(instance, lines),
      [WS_METHODS.guidesGet]: ({ key, revision }) => reviews.guide(key, revision),
      // Pending review comments and GitHub review threads.
      [WS_METHODS.reviewCommentsList]: ({ key, accountId }) => reviewComments.list(key, accountId),
      [WS_METHODS.reviewCommentsAdd]: ({ key, accountId, placement, body }) =>
        reviewComments.add(key, accountId, placement, body),
      [WS_METHODS.reviewCommentsEdit]: ({ id, body }) => reviewComments.edit(id, body),
      [WS_METHODS.reviewCommentsMove]: ({ id, placement }) => reviewComments.move(id, placement),
      [WS_METHODS.reviewCommentsDelete]: ({ id }) => reviewComments.remove(id),
      [WS_METHODS.reviewCommentsSubmit]: ({ key, accountId, event, body }) =>
        reviewComments.submit(key, accountId, event, body),
      [WS_METHODS.reviewThreadsList]: ({ key, accountId }) => pullRequests.threads(key, accountId),
      [WS_METHODS.reviewThreadsReply]: ({ key, accountId, threadId, body }) =>
        pullRequests.replyToThread(key, accountId, threadId, body),
      [WS_METHODS.reviewThreadsResolve]: ({ key, accountId, threadId, resolved }) =>
        pullRequests.resolveThread(key, accountId, threadId, resolved),
      [WS_METHODS.guidesDraft]: ({ key, attemptId }) => reviews.draft(key, attemptId),
      [WS_METHODS.guideSettingsGet]: () => guideSettings.get(),
      [WS_METHODS.guideSettingsUpdate]: (patch) => guideSettings.update(patch),
      [WS_METHODS.appearanceGet]: () => appearance.get(),
      [WS_METHODS.appearanceUpdate]: ({ theme }) => appearance.update(theme),
      [WS_METHODS.guideConfigScope]: ({ scope }) => guideConfig.scope(scope),
      [WS_METHODS.guideConfigPullRequest]: ({ key, accountId }) =>
        guideConfig.forPullRequest(key, accountId),
      [WS_METHODS.guideConfigRepositories]: () => guideConfig.repositories(),
      [WS_METHODS.guideConfigFindRepository]: (input) => guideConfig.findRepository(input),
      [WS_METHODS.guideConfigSave]: (input) => guideConfig.save(input),
      [WS_METHODS.agentsCatalog]: ({ refresh, instance }) => agents.catalog(refresh, instance),
      [WS_METHODS.agentsSignIn]: ({ instance }) => agents.signIn(instance),
      [WS_METHODS.agentsSignOut]: ({ instance }) => agents.signOut(instance),
      [WS_METHODS.agentsCreate]: ({ config }) => agents.create(config),
      [WS_METHODS.agentsUpdate]: ({ config }) => agents.update(config),
      [WS_METHODS.agentsRemove]: ({ instance }) => agents.remove(instance),
      [WS_METHODS.agentsReset]: ({ instance }) => agents.reset(instance),
      [WS_METHODS.agentsInstallCursor]: () =>
        cursorSdk.install.pipe(Stream.ensuring(agents.invalidate)),
      // The fix agent: review fixes and merge conflicts.
      [WS_METHODS.fixersGet]: ({ key }) => fixers.get(key),
      [WS_METHODS.fixersWatch]: ({ key }) => fixers.watch(key),
      [WS_METHODS.fixersFeed]: () => fixers.feed(),
      [WS_METHODS.fixersSend]: ({ key, accountId, agent, targets, note, replyAfterPush }) =>
        fixers.send(key, accountId, {
          ...(agent === undefined ? {} : { agent }),
          targets,
          note,
          replyAfterPush,
        }),
      [WS_METHODS.fixersResolveConflicts]: ({ key, accountId, agent, strategy }) =>
        fixers.resolveConflicts(key, accountId, {
          ...(agent === undefined ? {} : { agent }),
          strategy,
        }),
      [WS_METHODS.fixersPush]: ({ key, turnId }) => fixers.push(key, turnId),
      [WS_METHODS.fixersDiscard]: ({ key, turnId }) => fixers.discard(key, turnId),
      [WS_METHODS.fixersRevise]: ({ key, turnId, note }) => fixers.revise(key, turnId, note),
      [WS_METHODS.fixersRetry]: ({ key, turnId }) => fixers.retry(key, turnId),
      [WS_METHODS.fixersRevert]: ({ key, turnId }) => fixers.revert(key, turnId),
      [WS_METHODS.fixersStop]: ({ key }) => fixers.stop(key),
      [WS_METHODS.fixersDiff]: ({ key, turnId }) => fixers.diff(key, turnId),
      [WS_METHODS.fixersPatch]: ({ key, turnId }) => fixers.patch(key, turnId),
      [WS_METHODS.fixersScriptAccess]: ({ key, accountId }) => fixers.scriptAccess(key, accountId),
      [WS_METHODS.fixersPushAccess]: ({ key, accountId }) => fixers.pushAccess(key, accountId),
      [WS_METHODS.fixerSettingsList]: () => fixerSettings.list(),
      [WS_METHODS.fixerSettingsUpdate]: (patch) => fixerSettings.update(patch),
      [WS_METHODS.cliInstallGet]: () => cliInstall.get(),
      [WS_METHODS.cliInstall]: () => cliInstall.install(),
      [WS_METHODS.cliUninstall]: () => cliInstall.uninstall(),
      [WS_METHODS.cliSkillInstall]: () => cliInstall.openSkillInstaller(),
      [WS_METHODS.outsideAgentsGet]: () => outsideAgents.get(),
      [WS_METHODS.outsideAgentsUpdate]: (settings) => outsideAgents.update(settings),
      [WS_METHODS.outsideAgentsReset]: () => outsideAgents.reset(),
      [WS_METHODS.appInfo]: () =>
        Effect.succeed({
          version: config.version,
          buildId,
          home: config.home,
          startedAt: config.startedAt,
        }),
    });
  }),
);

// A defect in a handler fails only its own request instead of the whole socket.
const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const server = yield* HttpServer.HttpServer;
    const ownOrigins = Option.match(boundPort(server.address), {
      onNone: () => [],
      onSome: (port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    });
    const allowedOrigins = new Set([...ownOrigins, ...Option.toArray(config.devWebOrigin)]);
    const rpcHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, WS_RPC_SERVER_OPTIONS);

    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const decision = decideUpgrade({
          origin: request.headers["origin"],
          token: Option.match(url, {
            onNone: () => null,
            onSome: (value) => value.searchParams.get("token"),
          }),
          expectedToken: config.authToken,
          allowedOrigins,
        });
        if (decision._tag === "Reject") {
          yield* Effect.logWarning("Rejected /ws upgrade").pipe(
            Effect.annotateLogs({ status: decision.status }),
          );
          return HttpServerResponse.text(decision.message, { status: decision.status });
        }
        return yield* rpcHttpEffect;
      }),
    );
  }).pipe(Effect.provide(Layer.mergeAll(layerHandlers, RpcSerialization.layerJson))),
);
