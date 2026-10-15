import { fileURLToPath } from "node:url";

import { childEnv, CursorSdkInstallError, type CursorSdkInstallProgress } from "@prkit/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Base64, Hex } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { installRoot } from "./sdkLoader.ts";
import { packagesFor, type SdkPackage, supportsPlatform } from "./sdkPackages.ts";

const PARTIAL = ".partial-";

/** npm's integrity string for `bytes`. */
export const integrityOf = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return `sha512-${Base64.encode(yield* crypto.digest("SHA-512", bytes))}`;
  });

const failure = (message: string) => new CursorSdkInstallError({ message });

/** The tarball's bytes: from npm's registry, or from a file for a stand-in. */
const download = (entry: SdkPackage) =>
  Effect.gen(function* () {
    if (entry.url.startsWith("file:")) {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFile(fileURLToPath(entry.url));
    }
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .get(entry.url)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    return new Uint8Array(yield* response.arrayBuffer);
  }).pipe(
    Effect.timeout("2 minutes"),
    Effect.mapError(() =>
      failure(
        `prkit couldn't download ${entry.name} from npm. Check your connection, then try again.`,
      ),
    ),
  );

/**
 * Downloads one package, refuses it unless it matches the integrity prkit pins, and unpacks it
 * under `nodeModules`. Unpacking runs no install scripts: tar only writes files.
 */
const installPackage = (entry: SdkPackage, temp: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bytes = yield* download(entry);
    if ((yield* integrityOf(bytes)) !== entry.integrity)
      return yield* failure(
        `${entry.name} ${entry.version} from npm isn't the file prkit expects, so prkit didn't install it. Try again later.`,
      );
    const tarball = path.join(temp, "tarballs", `${entry.name.replaceAll("/", "+")}.tgz`);
    const target = path.join(temp, "node_modules", ...entry.name.split("/"));
    yield* fs.makeDirectory(path.dirname(tarball), { recursive: true });
    yield* fs.makeDirectory(target, { recursive: true });
    yield* fs.writeFile(tarball, bytes);
    // An npm tarball holds one top folder (`package/`), dropped here. bsdtar refuses absolute
    // paths and `..` without -P, so nothing lands outside `target`.
    const code = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "/usr/bin/tar",
            ["-xzf", tarball, "-C", target, "--strip-components", "1", "--no-same-owner"],
            {
              env: childEnv(process.env),
              extendEnv: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ),
        );
        return yield* child.exitCode;
      }),
    );
    if (code !== 0) return yield* failure(`prkit couldn't unpack ${entry.name}. Try again.`);
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(failure(`prkit couldn't write ${entry.name} to its folder. Try again.`)),
    ),
  );

/**
 * Installs Cursor's SDK into `$PRKIT_HOME/cursor-sdk/<version>`: each package into a temporary
 * folder, then one rename, so the SDK is either all there or not there. Already there is done.
 * A run that stopped halfway leaves only a temporary folder, which the next run removes, and
 * other versions' folders go once this one is there.
 */
export const install = (options: {
  readonly home: string;
  readonly packages: ReadonlyArray<SdkPackage>;
  readonly platform: string;
}): Stream.Stream<
  CursorSdkInstallProgress,
  CursorSdkInstallError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = installRoot(path, options.home);
      const entry = path.join(root, "node_modules", "@cursor", "sdk", "dist", "esm", "index.js");
      const list = packagesFor(options.packages, options.platform);
      const total = list.length;
      const parent = path.dirname(root);
      /**
       * Other versions' folders: a version prkit no longer pins is never loaded again. Only
       * tidying, so one it can't remove stays, and the install still counts.
       */
      const removeStale = Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(parent))
          if (name !== path.basename(root) && !name.startsWith(PARTIAL))
            yield* fs.remove(path.join(parent, name), { recursive: true, force: true });
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.logWarning("prkit couldn't remove an old Cursor SDK").pipe(
            Effect.annotateLogs({ message: error.message }),
          ),
        ),
      );
      if (yield* fs.exists(entry)) {
        yield* removeStale;
        return Stream.make({ name: null, done: total, total });
      }
      if (!supportsPlatform(options.packages, options.platform))
        return yield* failure(
          `Cursor's SDK doesn't run on this computer (${options.platform}). Cursor support needs a Mac.`,
        );
      yield* fs.makeDirectory(parent, { recursive: true });
      for (const name of yield* fs.readDirectory(parent))
        if (name.startsWith(PARTIAL))
          yield* fs.remove(path.join(parent, name), { recursive: true, force: true });
      const crypto = yield* Crypto.Crypto;
      const temp = path.join(parent, `${PARTIAL}${Hex.encode(yield* crypto.randomBytes(6))}`);
      yield* fs.makeDirectory(temp);
      const steps = Stream.fromIterable(list.entries()).pipe(
        Stream.flatMap(([index, item]) =>
          Stream.make({ name: item.name, done: index, total }).pipe(
            Stream.concat(Stream.fromEffect(installPackage(item, temp)).pipe(Stream.drain)),
          ),
        ),
      );
      const finish = Effect.gen(function* () {
        yield* fs.remove(path.join(temp, "tarballs"), { recursive: true, force: true });
        // Another install may have finished first; then its copy stays and this one goes.
        const moved = yield* fs.rename(temp, root).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", () =>
            fs.exists(entry).pipe(Effect.map((there) => !there)),
          ),
        );
        if (!(yield* fs.exists(entry)))
          return yield* failure("prkit couldn't finish installing Cursor's SDK. Try again.");
        if (!moved) yield* fs.remove(temp, { recursive: true, force: true });
        yield* removeStale;
        yield* Effect.logInfo("Installed Cursor's SDK").pipe(Effect.annotateLogs({ root }));
        return { name: null, done: total, total };
      }).pipe(
        Effect.catchTag("PlatformError", () =>
          Effect.fail(failure("prkit couldn't finish installing Cursor's SDK. Try again.")),
        ),
      );
      return steps.pipe(
        Stream.concat(Stream.fromEffect(finish)),
        Stream.onExit((exit) =>
          exit._tag === "Success"
            ? Effect.void
            : fs.remove(temp, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(failure("prkit couldn't prepare its folder for Cursor's SDK. Try again.")),
      ),
    ),
  );
