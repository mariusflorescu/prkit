// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem entries exercise install ownership and a swap during uninstall.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { expect, it, vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { make, preferredInstallDirectory } from "./CliInstall.ts";

const withHome = async (test: (home: string, install: string) => Promise<void>) => {
  const directory = NodePath.resolve(".e2e/unit-cli");
  NodeFs.mkdirSync(directory, { recursive: true });
  const home = NodeFs.mkdtempSync(NodePath.join(directory, "install-"));
  const install = NodePath.join(home, "local-bin/prkit");
  vi.stubEnv("HOME", home);
  vi.stubEnv("PRKIT_CLI_INSTALL_PATH", install);
  try {
    await test(home, install);
  } finally {
    vi.unstubAllEnvs();
    NodeFs.rmSync(home, { recursive: true, force: true });
  }
};

const run = <A, E>(
  home: string,
  test: (installer: Effect.Success<typeof make>) => Effect.Effect<A, E>,
  filesystem: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const installer = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, filesystem(fs)),
      );
      return yield* test(installer);
    }).pipe(
      Effect.provideService(ServerConfig, {
        host: "127.0.0.1",
        port: 0,
        home,
        dbPath: NodePath.join(home, "prkit.sqlite"),
        webDist: Option.none(),
        devWebOrigin: Option.none(),
        authToken: Redacted.make("test"),
        watchIntervalMs: 60_000,
        devReviewRequested: [],
        version: "0",
        startedAt: "2026-10-15T00:00:00.000Z",
      }),
      Effect.provide(NodeServices.layer),
    ),
  );

it("installs into a new owner-owned 0755 folder and removes only its link", () =>
  withHome(async (home, install) => {
    await run(home, (installer) =>
      Effect.gen(function* () {
        expect((yield* installer.install()).status).toBe("installed");
        expect(NodeFs.readlinkSync(install)).toBe(NodePath.join(home, "bin/prkit"));
        const folder = NodeFs.statSync(NodePath.dirname(install));
        expect(folder.mode & 0o777).toBe(0o755);
        expect(folder.uid).toBe(process.getuid?.());
        expect((yield* installer.uninstall()).status).toBe("absent");
        expect(NodeFs.readdirSync(NodePath.dirname(install))).toEqual([]);
      }),
    );
  }));

it("restores a foreign file swapped in immediately before uninstall moves the link", () =>
  withHome(async (home, install) => {
    let swapped = false;
    const result = await run(
      home,
      (installer) =>
        Effect.gen(function* () {
          yield* installer.install();
          return yield* installer.uninstall().pipe(Effect.result);
        }),
      (fs) => ({
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (from === install && !swapped) {
              swapped = true;
              NodeFs.unlinkSync(install);
              NodeFs.writeFileSync(install, "foreign command\n", { mode: 0o640 });
            }
            yield* fs.rename(from, to);
          }),
      }),
    );
    expect(swapped).toBe(true);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CliInstallError", message: expect.stringContaining("restored it") },
    });
    expect(NodeFs.readFileSync(install, "utf8")).toBe("foreign command\n");
    expect(NodeFs.lstatSync(install).isFile()).toBe(true);
    expect(NodeFs.statSync(install).mode & 0o777).toBe(0o640);
    expect(NodeFs.readdirSync(NodePath.dirname(install))).toEqual(["prkit"]);
  }));

it.each([0o775, 0o757])("falls back from a shared folder with mode %i", (mode) =>
  withHome(async (home) => {
    const preferred = NodePath.join(home, "preferred-bin");
    const fallback = NodePath.join(home, ".local/bin");
    NodeFs.mkdirSync(preferred);
    NodeFs.chmodSync(preferred, mode);
    expect(
      await Effect.runPromise(
        preferredInstallDirectory(preferred, fallback).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toBe(fallback);
  }),
);

it("preserves both foreign entries when the original uninstall location is occupied", () =>
  withHome(async (home, install) => {
    let moved = "";
    const foreignTarget = NodePath.join(home, "missing-foreign-target");
    const result = await run(
      home,
      (installer) =>
        Effect.gen(function* () {
          yield* installer.install();
          return yield* installer.uninstall().pipe(Effect.result);
        }),
      (fs) => ({
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (from === install) {
              NodeFs.unlinkSync(install);
              NodeFs.writeFileSync(install, "foreign command\n");
            }
            yield* fs.rename(from, to);
            if (from === install) {
              moved = to;
              NodeFs.symlinkSync(foreignTarget, install);
            }
          }),
      }),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CliInstallError", message: expect.stringContaining(moved) },
    });
    expect(moved).not.toBe("");
    expect(NodeFs.readFileSync(moved, "utf8")).toBe("foreign command\n");
    expect(NodeFs.readlinkSync(install)).toBe(foreignTarget);
  }));

it("prefers an owner-owned nonshared writable folder", () =>
  withHome(async (home) => {
    const preferred = NodePath.join(home, "preferred-bin");
    NodeFs.mkdirSync(preferred, { mode: 0o755 });
    expect(
      await Effect.runPromise(
        preferredInstallDirectory(preferred, NodePath.join(home, ".local/bin")).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    ).toBe(preferred);
  }));

it("rejects an override's shared folder and names the folder and reason", () =>
  withHome(async (home, install) => {
    const folder = NodePath.dirname(install);
    NodeFs.mkdirSync(folder);
    NodeFs.chmodSync(folder, 0o775);
    const result = await run(home, (installer) => installer.install().pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "CliInstallError",
        message: `prkit can't use ${folder}: it is writable by group or others.`,
      },
    });
    expect(NodeFs.readdirSync(folder)).toEqual([]);
  }));

it("rejects a writable folder owned by another uid", () =>
  withHome(async (home, install) => {
    const folder = NodePath.dirname(install);
    NodeFs.mkdirSync(folder, { mode: 0o755 });
    const result = await run(
      home,
      (installer) => installer.install().pipe(Effect.result),
      (fs) => ({
        ...fs,
        stat: (file) =>
          fs
            .stat(file)
            .pipe(
              Effect.map((info) =>
                file === folder
                  ? Object.assign({}, info, { uid: Option.some((process.getuid?.() ?? 0) + 1) })
                  : info,
              ),
            ),
      }),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "CliInstallError",
        message: `prkit can't use ${folder}: it isn't owned by the current user.`,
      },
    });
    expect(NodeFs.readdirSync(folder)).toEqual([]);
  }));
