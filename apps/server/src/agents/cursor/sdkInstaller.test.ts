import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { install, integrityOf } from "./sdkInstaller.ts";
import { installRoot } from "./sdkLoader.ts";
import type { SdkPackage } from "./sdkPackages.ts";

// Stand-in tarballs are file URLs, so nothing here reaches the network.
const noNetwork = HttpClient.make(() => Effect.die("the installer tests never use the network"));
const services = Layer.merge(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, noNetwork));
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof services>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(services)));
const runExit = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof services>>) =>
  Effect.runPromise(Effect.exit(effect).pipe(Effect.provide(services)));

let root = "";

/** An npm-shaped tarball (`package/...`) holding `files`, with its file URL and integrity. */
const tarball = (name: string, files: Readonly<Record<string, string>>, platform?: string) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* fs.makeTempDirectory({ directory: root, prefix: "source-" });
      for (const [file, text] of Object.entries(files)) {
        const target = path.join(source, "package", file);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, text);
      }
      const file = path.join(root, `${name.replaceAll("/", "+")}-${source.slice(-6)}.tgz`);
      yield* Effect.scoped(
        spawner
          .spawn(ChildProcess.make("/usr/bin/tar", ["-czf", file, "-C", source, "package"]))
          .pipe(Effect.flatMap((child) => child.exitCode)),
      );
      const entry: SdkPackage = {
        name,
        version: "1.0.0",
        integrity: yield* integrityOf(yield* fs.readFile(file)),
        url: `file://${file}`,
        ...(platform === undefined ? {} : { platform }),
      };
      return entry;
    }),
  );

const SDK_FILES = { "package.json": "{}", "dist/esm/index.js": "export const Agent = {};\n" };

const installAll = (home: string, packages: ReadonlyArray<SdkPackage>) =>
  install({ home, packages, platform: "darwin-arm64" }).pipe(Stream.runCollect);

const listing = (home: string) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = path.dirname(installRoot(path, home));
      return (yield* fs.exists(parent)) ? yield* fs.readDirectory(parent) : [];
    }),
  );

describe("installing Cursor's SDK", () => {
  beforeAll(async () => {
    root = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "prkit-cursor-sdk-" });
      }),
    );
  });
  afterAll(() =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(root, { recursive: true });
      }),
    ),
  );

  it("unpacks every package this machine needs, reports each, and keeps no tarball", async () => {
    const home = `${root}/home-ok`;
    const packages = [
      await tarball("@cursor/sdk", SDK_FILES),
      await tarball("@cursor/sdk-darwin-arm64", { "bin/rg": "rg" }, "darwin-arm64"),
      await tarball("@cursor/sdk-linux-x64", { "bin/rg": "rg" }, "linux-x64"),
      await tarball("zod", { "index.js": "" }),
    ];
    const progress = await run(installAll(home, packages));
    expect(progress).toEqual([
      { name: "@cursor/sdk", done: 0, total: 3 },
      { name: "@cursor/sdk-darwin-arm64", done: 1, total: 3 },
      { name: "zod", done: 2, total: 3 },
      { name: null, done: 3, total: 3 },
    ]);
    const installed = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const modules = path.join(installRoot(path, home), "node_modules");
        return {
          sdk: yield* fs.readFileString(path.join(modules, "@cursor/sdk/dist/esm/index.js")),
          platform: yield* fs.exists(path.join(modules, "@cursor/sdk-darwin-arm64/bin/rg")),
          other: yield* fs.exists(path.join(modules, "@cursor/sdk-linux-x64")),
          tarballs: yield* fs.exists(path.join(installRoot(path, home), "tarballs")),
        };
      }),
    );
    expect(installed).toEqual({
      sdk: SDK_FILES["dist/esm/index.js"],
      platform: true,
      other: false,
      tarballs: false,
    });
    expect(await listing(home)).toEqual(["1.0.37"]);
  });

  it("refuses a package whose bytes don't match the pinned integrity, and installs nothing", async () => {
    const home = `${root}/home-mismatch`;
    const good = await tarball("@cursor/sdk", SDK_FILES);
    const platform = await tarball("@cursor/sdk-darwin-arm64", {}, "darwin-arm64");
    const tampered = { ...(await tarball("zod", { "index.js": "" })), integrity: good.integrity };
    const exit = await runExit(installAll(home, [good, platform, tampered]));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "isn't the file prkit expects",
    );
    expect(await listing(home)).toEqual([]);
  });

  it("removes what a stopped install left behind, and starts again from nothing", async () => {
    const home = `${root}/home-partial`;
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${home}/cursor-sdk/.partial-abc/node_modules/@cursor/sdk`, {
          recursive: true,
        });
      }),
    );
    const missing: SdkPackage = {
      name: "@cursor/sdk",
      version: "1.0.0",
      integrity: "sha512-none",
      url: `file://${root}/does-not-exist.tgz`,
    };
    const platform = await tarball("@cursor/sdk-darwin-arm64", {}, "darwin-arm64");
    const exit = await runExit(installAll(home, [missing, platform]));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("couldn't download");
    expect(await listing(home)).toEqual([]);
    const sdk = await tarball("@cursor/sdk", SDK_FILES);
    await run(installAll(home, [sdk, platform]));
    expect(await listing(home)).toEqual(["1.0.37"]);
  });

  it("removes the folders of versions prkit no longer pins once this one is in", async () => {
    const home = `${root}/home-stale`;
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${home}/cursor-sdk/1.0.30/node_modules/@cursor/sdk`, {
          recursive: true,
        });
      }),
    );
    const sdk = await tarball("@cursor/sdk", SDK_FILES);
    const platform = await tarball("@cursor/sdk-darwin-arm64", {}, "darwin-arm64");
    await run(installAll(home, [sdk, platform]));
    expect(await listing(home)).toEqual(["1.0.37"]);
  });

  it("does nothing when the SDK is already installed", async () => {
    const home = `${root}/home-ok`;
    const unreadable: SdkPackage = {
      name: "@cursor/sdk",
      version: "1.0.0",
      integrity: "sha512-none",
      url: `file://${root}/does-not-exist.tgz`,
    };
    const platform = { ...unreadable, name: "@cursor/sdk-darwin-arm64", platform: "darwin-arm64" };
    expect(await run(installAll(home, [unreadable, platform]))).toEqual([
      { name: null, done: 2, total: 2 },
    ]);
  });

  it("refuses a machine Cursor publishes no SDK for", async () => {
    const sdk = await tarball("@cursor/sdk", SDK_FILES);
    const linux = await tarball("@cursor/sdk-linux-x64", {}, "linux-x64");
    const exit = await runExit(
      install({ home: `${root}/home-mac`, packages: [sdk, linux], platform: "darwin-arm64" }).pipe(
        Stream.runCollect,
      ),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("needs a Mac");
  });
});
