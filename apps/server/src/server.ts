// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes a raw node:http server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ServerReadyLineJson } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as ServerConfig from "./config.ts";
import * as AppearanceStore from "./appearance/AppearanceStore.ts";
import * as GitHubAccounts from "./accounts/GitHubAccounts.ts";
import * as GitHubApi from "./github/GitHubApi.ts";
import * as GitHubHttpClient from "./github/httpClient.ts";
import * as PullRequests from "./pullRequests/PullRequests.ts";
import * as Agents from "./agents/Agents.ts";
import * as CursorSdk from "./agents/cursor/CursorSdk.ts";
import * as McpHttp from "./mcp/McpHttp.ts";
import * as McpTokens from "./mcp/McpTokens.ts";
import * as RepoCache from "./repo/RepoCache.ts";
import * as AutoGuides from "./reviews/AutoGuides.ts";
import * as GuideConfigStore from "./reviews/GuideConfigStore.ts";
import * as GuideSettingsStore from "./reviews/GuideSettingsStore.ts";
import * as Reviews from "./reviews/Reviews.ts";
import * as ReviewComments from "./reviewComments/ReviewComments.ts";
import * as Fixers from "./fixers/Fixers.ts";
import * as FixerSettingsStore from "./fixers/FixerSettingsStore.ts";
import * as FixerWatcher from "./fixers/FixerWatcher.ts";
import * as ReviewWatcher from "./reviews/ReviewWatcher.ts";
import * as ServerHttp from "./http.ts";
import { boundPort } from "./listenAddress.ts";
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
    const port = Option.getOrElse(boundPort(server.address), () => config.port);
    const line = yield* encodeReadyLine({
      type: "ready",
      port,
      url: `http://${config.host}:${port}`,
      theme: yield* appearance.current(),
    });
    yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout()));
    yield* Effect.logInfo("prkit server listening").pipe(
      Effect.annotateLogs({ port, home: config.home }),
    );
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
  ServerHttp.layerStaticRoute,
);

const layerAccounts = GitHubAccounts.layer.pipe(Layer.provide(GitHubHttpClient.layer));
const layerGitHub = GitHubApi.layer.pipe(
  Layer.provide(GitHubHttpClient.layer),
  Layer.provideMerge(layerAccounts),
);
const layerPullRequests = PullRequests.layer.pipe(Layer.provideMerge(layerGitHub));
// Reviews: the lifecycle, its git cache, agents, and the per-attempt MCP tokens. The
// watcher builds after Reviews, so it starts once startup reconciliation is done.
const layerReviews = Layer.mergeAll(ReviewWatcher.layer, AutoGuides.layer).pipe(
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
  Layer.provideMerge(
    HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }),
  ),
  Layer.provide(Layer.mergeAll(ReviewComments.layer, AppearanceStore.layer)),
  Layer.provide(layerFixers),
  Layer.provide(SqlitePersistence.layer),
  Layer.provideMerge(layerHttpServer),
);

// The CLI supplies ServerConfig. The home lock builds first, so a second server for the
// same home never touches the database or listens.
export const runServer = Layer.launch(layerServer.pipe(Layer.provide(HomeLock.layer)));
