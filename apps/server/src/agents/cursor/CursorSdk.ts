import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { CursorSdkInstallError } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { install } from "./sdkInstaller.ts";
import { machinePlatform, SDK_PACKAGES, SdkPackage } from "./sdkPackages.ts";

/** e2e only (PRKIT_E2E=1): a JSON list of stand-in packages to install instead of npm's. */
const MANIFEST_VARIABLE = "PRKIT_CURSOR_SDK_MANIFEST";
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(SdkPackage)));

/** Cursor's SDK, installed into prkit's folder when the user asks for it. One install at a time. */
export class CursorSdk extends Context.Service<CursorSdk, Effect.Success<typeof make>>()(
  "@prkit/server/agents/cursor/CursorSdk",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* ServerConfig;
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  >();
  const installing = yield* Semaphore.make(1);

  const packages = Effect.gen(function* () {
    const override = process.env[MANIFEST_VARIABLE];
    if (process.env.PRKIT_E2E !== "1" || override === undefined || override === "")
      return SDK_PACKAGES;
    return yield* fs.readFileString(override).pipe(
      Effect.flatMap(decodeManifest),
      Effect.mapError(
        () => new CursorSdkInstallError({ message: `prkit couldn't read ${override}.` }),
      ),
    );
  });

  const run = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(installing.take(1), () => installing.release(1));
      yield* Effect.logInfo("Installing Cursor's SDK");
      return install({ home: server.home, packages: yield* packages, platform: machinePlatform() });
    }),
  ).pipe(
    Stream.tapError((error) =>
      Effect.logWarning("Couldn't install Cursor's SDK").pipe(
        Effect.annotateLogs({ message: error.message }),
      ),
    ),
    Stream.provideContext(services),
  );

  return { install: run };
});

export const layer = Layer.effect(CursorSdk, make).pipe(Layer.provide(NodeHttpClient.layerUndici));
