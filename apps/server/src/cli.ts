import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import * as ServerConfig from "./config.ts";
import { runServer } from "./server.ts";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));

const serverCommand = Command.make("prkit-server", {
  port: Flag.Int("port").pipe(
    Flag.withSchema(PortSchema),
    Flag.withDescription("Port to listen on. 0 picks a free port."),
    Flag.withFallbackConfig(Config.Int("PRKIT_PORT")),
    Flag.withDefault(0),
  ),
  host: Flag.Literals("host", [ServerConfig.SERVER_HOST]).pipe(
    Flag.withDescription("Interface to bind. Loopback only."),
    Flag.withDefault(ServerConfig.SERVER_HOST),
  ),
  webDist: Flag.Directory("web-dist", { mustExist: true }).pipe(
    Flag.withDescription("Built web UI to serve, with SPA fallback."),
    Flag.optional,
  ),
  devWebOrigin: Flag.String("dev-web-origin").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Vite dev origin allowed to open /ws."),
    Flag.withFallbackConfig(Config.URL("PRKIT_DEV_WEB_ORIGIN")),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Run the prkit server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.resolve(flags);
      return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
    }),
  ),
);

Command.run(serverCommand, { version: packageJson.version }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);
