import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat distinguishes the replaced launcher from its symlink
import * as NodeFs from "node:fs";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { make } from "./OutsideAgents.ts";

const Harness = Layer.merge(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" }));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(".e2e", { recursive: true });
  const home = yield* fs.makeTempDirectoryScoped({
    directory: path.resolve(".e2e"),
    prefix: "outside-launchers-",
  });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PRKIT_CLI_INSTALL_PATH", `${home}/local-bin/prkit`);
  yield* fs.makeDirectory(`${home}/bin`);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`;
  const outside = yield* make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, {
      host: ServerConfig.SERVER_HOST,
      port: 0,
      home,
      dbPath: ":memory:",
      webDist: Option.none(),
      devWebOrigin: Option.none(),
      authToken: Redacted.make("test"),
      watchIntervalMs: 60_000,
      devReviewRequested: [],
      e2e: false,
      version: "0.0.0",
      startedAt: "2026-10-15T00:00:00.000Z",
    }),
  );
  return { fs, home, outside };
});

afterEach(() => vi.unstubAllEnvs());

describe("outside launcher publication", () => {
  it("replaces planted symlinks with private launchers without changing either target", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, home, outside } = yield* fixture;
        const launchers = [
          { name: "prkit", mode: "cli", victimMode: 0o640 },
          { name: "prkit-mcp", mode: "mcp-bridge", victimMode: 0o644 },
        ];
        for (const { name, victimMode } of launchers) {
          const victim = `${home}/${name}-victim`;
          yield* fs.writeFileString(victim, `${name} target stays untouched\n`);
          yield* fs.chmod(victim, victimMode);
          yield* fs.symlink(victim, `${home}/bin/${name}`);
        }

        yield* outside.start(12345);

        for (const { name, mode, victimMode } of launchers) {
          const launcher = `${home}/bin/${name}`;
          const info = NodeFs.lstatSync(launcher);
          expect(info.isFile()).toBe(true);
          expect(info.isSymbolicLink()).toBe(false);
          expect(info.mode & 0o777).toBe(0o700);
          expect(yield* fs.readFileString(launcher)).toContain(` ${mode} "$@"\n`);
          expect(yield* fs.readFileString(`${home}/${name}-victim`)).toBe(
            `${name} target stays untouched\n`,
          );
          expect((yield* fs.stat(`${home}/${name}-victim`)).mode & 0o777).toBe(victimMode);
        }
        expect((yield* fs.readDirectory(`${home}/bin`)).sort()).toEqual(["prkit", "prkit-mcp"]);
      }).pipe(Effect.scoped, Effect.provide(Harness)),
    ));

  it("leaves a symlinked launcher folder and both targets untouched while startup succeeds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, home, outside } = yield* fixture;
        const target = `${home}/foreign-bin`;
        yield* fs.makeDirectory(target);
        const victims = [
          { name: "prkit", mode: 0o640 },
          { name: "prkit-mcp", mode: 0o644 },
        ];
        for (const { name, mode } of victims) {
          yield* fs.writeFileString(`${target}/${name}`, `${name} stays untouched\n`);
          yield* fs.chmod(`${target}/${name}`, mode);
        }
        yield* fs.remove(`${home}/bin`, { recursive: true });
        yield* fs.symlink(target, `${home}/bin`);

        yield* outside.start(12345);

        expect(NodeFs.lstatSync(`${home}/bin`).isSymbolicLink()).toBe(true);
        expect((yield* fs.readDirectory(target)).sort()).toEqual(["prkit", "prkit-mcp"]);
        for (const { name, mode } of victims) {
          expect(yield* fs.readFileString(`${target}/${name}`)).toBe(`${name} stays untouched\n`);
          expect((yield* fs.stat(`${target}/${name}`)).mode & 0o777).toBe(mode);
        }
        expect(yield* fs.exists(outside.discoveryPath)).toBe(true);
        const state = yield* outside.get();
        expect(state.launcherProblem).toContain(`${home}/bin`);
        expect(state.launcherProblem).toContain("restart prkit");
        expect(outside.launcherProblem()).toBe(state.launcherProblem);
      }).pipe(Effect.scoped, Effect.provide(Harness)),
    ));

  it.each(["prkit", "prkit-mcp"])("removes the staged file when %s cannot be replaced", (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, home, outside } = yield* fixture;
        yield* fs.makeDirectory(`${home}/bin/${name}`);

        const exit = yield* outside.start(12345).pipe(Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect((yield* fs.stat(`${home}/bin/${name}`)).type).toBe("Directory");
        expect((yield* fs.readDirectory(`${home}/bin`)).some((file) => file.endsWith(".tmp"))).toBe(
          false,
        );
        expect(yield* fs.exists(outside.discoveryPath)).toBe(true);
        expect((yield* outside.get()).launcherProblem).toContain("restart prkit");
      }).pipe(Effect.scoped, Effect.provide(Harness)),
    ),
  );
});
