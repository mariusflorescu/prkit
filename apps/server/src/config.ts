import * as NodeOS from "node:os";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import packageJson from "../package.json" with { type: "json" };

/** The server only ever binds loopback; see docs/internals/architecture.md "Auth between UI and server". */
export const SERVER_HOST = "127.0.0.1";

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly host: typeof SERVER_HOST;
    /** Requested listen port; 0 lets the OS pick one. The bound port comes from `HttpServer.address`. */
    readonly port: number;
    readonly home: string;
    readonly dbPath: string;
    readonly webDist: Option.Option<string>;
    /** The Vite dev origin allowed to open `/ws` next to the server's own origin. */
    readonly devWebOrigin: Option.Option<string>;
    readonly authToken: Redacted.Redacted<string>;
    /** How often the watcher reads every review's PR. */
    readonly watchIntervalMs: number;
    /**
     * Verification only: PR keys auto mode treats as review requests, because a test
     * can't ask real people to request a review. The desktop app never sets it.
     */
    readonly devReviewRequested: ReadonlyArray<string>;
    /** Verification only: an e2e instance (PRKIT_E2E=1), which honors a journey's holds (`e2eHold.ts`). */
    readonly e2e: boolean;
    readonly version: string;
    readonly startedAt: string;
  }
>()("@prkit/server/config/ServerConfig") {}

export interface ServerFlags {
  readonly port: number;
  readonly webDist: Option.Option<string>;
  readonly devWebOrigin: Option.Option<URL>;
}

const EnvConfig = Config.all({
  home: Config.String("PRKIT_HOME").pipe(Config.option),
  // Read once here. Child processes get `childEnv()`, which never carries it.
  authToken: Config.NonEmptyString("PRKIT_AUTH_TOKEN").pipe(Config.map(Redacted.make)),
  // The architecture's 60 seconds is also the floor; only e2e instances (PRKIT_E2E=1)
  // may tick faster, so a leftover dev instance never polls GitHub every few seconds.
  watchIntervalMs: Config.Int("PRKIT_WATCH_INTERVAL_MS").pipe(Config.withDefault(60_000)),
  e2e: Config.Boolean("PRKIT_E2E").pipe(Config.withDefault(false)),
  devReviewRequested: Config.String("PRKIT_DEV_REVIEW_REQUESTED").pipe(Config.withDefault("")),
  // The packaged app's version, which its build stamps; the bundle carries the workspace's.
  appVersion: Config.NonEmptyString("PRKIT_APP_VERSION").pipe(Config.option),
});

export const resolve = Effect.fn("ServerConfig.resolve")(function* (flags: ServerFlags) {
  const path = yield* Path.Path;
  const env = yield* EnvConfig;
  const home = path.resolve(
    Option.getOrElse(env.home, () => path.join(NodeOS.homedir(), ".prkit")),
  );
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  return ServerConfig.of({
    host: SERVER_HOST,
    port: flags.port,
    home,
    dbPath: path.join(home, "prkit.sqlite"),
    webDist: Option.map(flags.webDist, (dir) => path.resolve(dir)),
    devWebOrigin: Option.map(flags.devWebOrigin, (url) => url.origin),
    authToken: env.authToken,
    watchIntervalMs: Math.max(env.e2e ? 1_000 : 60_000, env.watchIntervalMs),
    devReviewRequested: env.devReviewRequested
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== ""),
    e2e: env.e2e,
    version: Option.getOrElse(env.appVersion, () => packageJson.version),
    startedAt,
  });
});
