// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes a raw node:http server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ServerReadyLineJson } from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as ServerConfig from "./config.ts";
import * as AppearanceStore from "./appearance/AppearanceStore.ts";
import * as Asks from "./asks/Asks.ts";
import * as GitHubAccounts from "./accounts/GitHubAccounts.ts";
import * as GitHubApi from "./github/GitHubApi.ts";
import * as GitHubHttpClient from "./github/httpClient.ts";
import * as PullRequests from "./pullRequests/PullRequests.ts";
import * as Agents from "./agents/Agents.ts";
import * as CursorSdk from "./agents/cursor/CursorSdk.ts";
import * as McpHttp from "./mcp/McpHttp.ts";
import * as McpTokens from "./mcp/McpTokens.ts";
import * as OutsideMcp from "./mcp/outside/OutsideMcp.ts";
import * as CliInstall from "./cli/CliInstall.ts";
import * as OutsideAgents from "./outside/OutsideAgents.ts";
import * as OutsideWork from "./outside/OutsideWork.ts";
import * as RepoCache from "./repo/RepoCache.ts";
import * as AutoGuides from "./reviews/AutoGuides.ts";
import * as GuideConfigStore from "./reviews/GuideConfigStore.ts";
import * as GuideSettingsStore from "./reviews/GuideSettingsStore.ts";
import * as Reviews from "./reviews/Reviews.ts";
import * as ReviewComments from "./reviewComments/ReviewComments.ts";
import * as ManualCheckTicks from "./manualCheck/ManualCheckTicks.ts";
import * as ReadingState from "./readingState/ReadingState.ts";
import * as ReviewedFiles from "./reviewedFiles/ReviewedFiles.ts";
import * as Fixers from "./fixers/Fixers.ts";
import * as FixerSettingsStore from "./fixers/FixerSettingsStore.ts";
import * as FixerWatcher from "./fixers/FixerWatcher.ts";
import * as ReviewWatcher from "./reviews/ReviewWatcher.ts";
import * as ServerHttp from "./http.ts";
import { boundPort } from "./listenAddress.ts";
import * as LogFile from "./logs/LogFile.ts";
import * as HomeLock from "./persistence/HomeLock.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Ws from "./ws.ts";
import * as Workspace from "./workspace/Workspace.ts";

const encodeReadyLine = Schema.encodeEffect(ServerReadyLineJson);

/** The one line on stdout (see `ServerReadyLine`); everything else logs to stderr. */
const layerReadyLine = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const config = yield* ServerConfig.ServerConfig;
    const stdio = yield* Stdio.Stdio;
    const appearance = yield* AppearanceStore.AppearanceStore;
    const readiness = yield* ServerHttp.Readiness;
    const port = Option.getOrElse(boundPort(server.address), () => config.port);
    const line = yield* encodeReadyLine({
      type: "ready",
      port,
      url: `http://${config.host}:${port}`,
      theme: yield* appearance.current(),
    });
    yield* readiness.markReady;
    yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout()));
    yield* Effect.logInfo("prkit server listening").pipe(
      Effect.annotateLogs({ port, home: config.home }),
    );
  }),
);

/**
 * Outside agents' launcher and discovery file, once the server listens; the file goes when
 * it stops (docs/features/outside-agents.md).
 */
const layerOutsideDiscovery = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const outside = yield* OutsideAgents.OutsideAgents;
    const port = boundPort(server.address);
    if (Option.isSome(port)) yield* outside.start(port.value);
  }),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.port,
    });
  }),
);

const layerRoutes = Layer.mergeAll(
  ServerHttp.layerHealthRoute,
  ServerHttp.layerAppearanceRoute,
  Ws.layer,
  McpHttp.layer,
  OutsideMcp.layer,
  ServerHttp.layerStaticRoute,
);

const layerAccounts = GitHubAccounts.layer.pipe(Layer.provide(GitHubHttpClient.layer));
const layerGitHub = GitHubApi.layer.pipe(
  Layer.provide(GitHubHttpClient.layer),
  Layer.provideMerge(layerAccounts),
);
const layerPullRequests = PullRequests.layer.pipe(Layer.provideMerge(layerGitHub));
// Reviews: the lifecycle, its git cache, agents, and the per-attempt MCP tokens. The
// watcher builds after Reviews, so it starts once startup reconciliation is done. It also
// settles what the reader marked, so the services that store those marks build below it and
// the transports share its instances.
const layerReviews = Layer.mergeAll(ReviewWatcher.layer, AutoGuides.layer).pipe(
  Layer.provideMerge(ReadingState.layer),
  Layer.provideMerge(Layer.mergeAll(ReviewedFiles.layer, ManualCheckTicks.layer)),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      RepoCache.layer,
      Agents.layer,
      // Downloads from npm with the same HTTP client; nothing of GitHub's goes with it.
      CursorSdk.layer.pipe(Layer.provide(GitHubHttpClient.layer)),
      McpTokens.layer,
      GuideSettingsStore.layer,
      GuideConfigStore.layer,
      Workspace.layer,
    ),
  ),
  Layer.provideMerge(layerPullRequests),
);

// Fixes: the writable agent sessions. They read Reviews' guides, and their watcher
// builds after Fixers, so it starts once fix startup reconciliation is done.
const layerFixers = FixerWatcher.layer.pipe(
  Layer.provideMerge(Fixers.layer),
  Layer.provideMerge(FixerSettingsStore.layer),
  Layer.provideMerge(layerReviews),
);

const layerServer = layerReadyLine.pipe(
  Layer.provide(layerOutsideDiscovery),
  Layer.provideMerge(
    HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }),
  ),
  Layer.provideMerge(ServerHttp.layerReadiness),
  // What outside agents can do: the same services the app's buttons call.
  Layer.provideMerge(OutsideWork.layer),
  Layer.provideMerge(CliInstall.layer),
  Layer.provideMerge(OutsideAgents.layer),
  Layer.provideMerge(Layer.mergeAll(ReviewComments.layer, AppearanceStore.layer, Asks.layer)),
  Layer.provideMerge(layerFixers),
  Layer.provide(SqlitePersistence.layer),
  Layer.provideMerge(layerHttpServer),
);

// Everything the server logs goes to its file in the home as well as to stderr, which a
// Finder launch throws away.
const layerLogFile = Logger.layer(
  [LogFile.LogFile.use((logFile) => Effect.succeed(logFile.logger))],
  { mergeWithExisting: true },
).pipe(Layer.provideMerge(LogFile.layer));

// The CLI supplies ServerConfig. The home lock builds first, so a second server for the
// same home never touches the database, listens or writes into the first one's log.
export const runServer = Layer.launch(
  layerServer.pipe(
    // A server that can't start says why in its file too, before the logger closes.
    Layer.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("prkit server couldn't start", cause),
    ),
    Layer.provide(layerLogFile),
    Layer.provide(HomeLock.layer),
  ),
);
