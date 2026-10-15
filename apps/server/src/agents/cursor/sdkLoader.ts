import { pathToFileURL } from "node:url";

import type * as CursorSdk from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CURSOR_SDK_VERSION } from "./sdkPackages.ts";

/**
 * The one place prkit finds and loads Cursor's SDK. The packaged app doesn't contain it (it is
 * proprietary): the user installs it from Settings > Agents into `$PRKIT_HOME/cursor-sdk`.
 * Bundling it later instead would change only this module.
 */

/** Dev and e2e: the SDK package folder to load instead (the dev dependency, or a stand-in). */
export const SDK_PATH_VARIABLE = "PRKIT_CURSOR_SDK_PATH";

/** Where the installer puts this version's packages. */
export const installRoot = (path: Path.Path, home: string) =>
  path.join(home, "cursor-sdk", CURSOR_SDK_VERSION);

/** The SDK's package folder, installed or not. */
export const sdkPackageDir = (
  path: Path.Path,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
) => {
  const override = env[SDK_PATH_VARIABLE];
  return override !== undefined && override !== ""
    ? path.resolve(override)
    : path.join(installRoot(path, home), "node_modules", "@cursor", "sdk");
};

const entryOf = (packageDir: string) => `${packageDir}/dist/esm/index.js`;

/** The SDK's package folder when it is there to load, else null. */
export const findSdk = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = sdkPackageDir(path, home, env);
    return (yield* fs.exists(entryOf(packageDir)).pipe(Effect.orElseSucceed(() => false)))
      ? packageDir
      : null;
  });

/**
 * Loads the SDK in the runner process. The SDK finds its sandbox helper and ripgrep by walking
 * up from the host script (`argv[1]`) to a `node_modules` holding its platform package, so the
 * host script is the SDK's own entry: it finds the platform package installed next to it, and
 * never one from the checkout or from prkit's own folder.
 */
export const loadSdk = async (packageDir: string) => {
  const entry = entryOf(packageDir);
  process.argv[1] = entry;
  const sdk: typeof CursorSdk = await import(pathToFileURL(entry).href);
  return sdk;
};
