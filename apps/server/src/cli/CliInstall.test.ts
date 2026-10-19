// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem entries exercise install ownership and a swap during uninstall.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { OUTSIDE_AGENTS_DEFAULTS } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { expect, it, vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OutsideAgents } from "../outside/OutsideAgents.ts";
import { shellQuote } from "../outside/launcher.ts";
import { make, preferredInstallDirectory } from "./CliInstall.ts";

vi.mock("./skillBuild.ts", () => ({ skillBuild: { repository: "acme/widgets", ref: "main" } }));

const withHome = async (test: (home: string, install: string) => Promise<void>) => {
  const directory = NodePath.resolve(".e2e/unit-cli");
  NodeFs.mkdirSync(directory, { recursive: true });
  const home = NodeFs.mkdtempSync(NodePath.join(directory, "install-"));
  NodeFs.mkdirSync(NodePath.join(home, "bin"), { mode: 0o700 });
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
  launcherProblem: string | null = null,
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
        e2e: false,
        version: "0",
        startedAt: "2026-10-15T00:00:00.000Z",
      }),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(OutsideAgents, {
            current: () => OUTSIDE_AGENTS_DEFAULTS,
            discoveryPath: NodePath.join(home, "outside-agents.json"),
            launcher: NodePath.join(home, "bin/prkit-mcp"),
            launcherProblem: () => launcherProblem,
            port: () => Option.none(),
          }),
        ),
      ),
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

it.each(["file", "symlink"] as const)(
  "preserves both entries when a file appears immediately before restoring a foreign %s",
  (kind) =>
    withHome(async (home, install) => {
      let moved = "";
      let restoreCalls = 0;
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
                if (kind === "file") NodeFs.writeFileSync(install, "foreign command A\n");
                else NodeFs.symlinkSync(foreignTarget, install);
              }
              yield* fs.rename(from, to);
              if (from === install) moved = to;
            }),
          link: (from, to) =>
            Effect.gen(function* () {
              restoreCalls++;
              NodeFs.writeFileSync(install, "foreign command B\n");
              yield* fs.link(from, to);
            }),
          symlink: (from, to) =>
            Effect.gen(function* () {
              if (moved !== "") {
                restoreCalls++;
                NodeFs.writeFileSync(install, "foreign command B\n");
              }
              yield* fs.symlink(from, to);
            }),
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CliInstallError", message: expect.stringContaining(moved) },
      });
      expect(moved).not.toBe("");
      expect(restoreCalls).toBe(1);
      if (kind === "file") expect(NodeFs.readFileSync(moved, "utf8")).toBe("foreign command A\n");
      else expect(NodeFs.readlinkSync(moved)).toBe(foreignTarget);
      expect(NodeFs.readFileSync(install, "utf8")).toBe("foreign command B\n");
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          message: expect.stringContaining(`mv ${shellQuote(moved)} ${shellQuote(install)}`),
        },
      });
    }),
);

it("restores a swapped foreign symlink without following its target", () =>
  withHome(async (home, install) => {
    const target = NodePath.join(home, "foreign-target");
    NodeFs.writeFileSync(target, "untouched\n", { mode: 0o640 });
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
              NodeFs.symlinkSync(target, install);
            }
            yield* fs.rename(from, to);
          }),
      }),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("restored it") },
    });
    expect(NodeFs.readlinkSync(install)).toBe(target);
    expect(NodeFs.readFileSync(target, "utf8")).toBe("untouched\n");
    expect(NodeFs.statSync(target).mode & 0o777).toBe(0o640);
    expect(NodeFs.readdirSync(NodePath.dirname(install))).toEqual(["prkit"]);
  }));

it("preserves a swapped directory at the reported recovery path", () =>
  withHome(async (home, install) => {
    let moved = "";
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
              NodeFs.mkdirSync(install);
              NodeFs.writeFileSync(NodePath.join(install, "keep"), "untouched\n");
            }
            yield* fs.rename(from, to);
            if (from === install) moved = to;
          }),
      }),
    );
    expect(moved).not.toBe("");
    expect(NodeFs.existsSync(install)).toBe(false);
    expect(NodeFs.readFileSync(NodePath.join(moved, "keep"), "utf8")).toBe("untouched\n");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        message: expect.stringContaining(`mv ${shellQuote(moved)} ${shellQuote(install)}`),
      },
    });
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

it("rejects folders owned by a different uid", () =>
  withHome(async (home, install) => {
    const folder = NodePath.dirname(install);
    NodeFs.mkdirSync(folder, { mode: 0o755 });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("This test needs a Unix uid.");
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      const result = await run(home, (installer) => installer.install().pipe(Effect.result));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "CliInstallError",
          message: expect.stringMatching(/owned|owner/),
        },
      });
      expect(NodeFs.readdirSync(folder)).toEqual([]);
    } finally {
      getuid.mockRestore();
    }
  }));

it("falls back from a preferred folder below a group-writable parent and rejects the override", () =>
  withHome(async (home) => {
    const parent = NodePath.join(home, "shared-parent");
    const preferred = NodePath.join(parent, "bin");
    const fallback = NodePath.join(home, ".local/bin");
    NodeFs.mkdirSync(preferred, { recursive: true, mode: 0o755 });
    NodeFs.chmodSync(parent, 0o775);
    expect(await Effect.runPromise(preferredInstallDirectory(preferred, fallback))).toBe(fallback);
    vi.stubEnv("PRKIT_CLI_INSTALL_PATH", NodePath.join(preferred, "prkit"));
    const result = await run(home, (installer) => installer.install().pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: `prkit can't use ${parent}: it is writable by group or others.` },
    });
    expect(NodeFs.readdirSync(preferred)).toEqual([]);
  }));

it("rejects a user-owned symlink in an install folder's ancestry", () =>
  withHome(async (home) => {
    const target = NodePath.join(home, "target");
    const linked = NodePath.join(home, "linked-parent");
    const folder = NodePath.join(linked, "bin");
    NodeFs.mkdirSync(NodePath.join(target, "bin"), { recursive: true, mode: 0o755 });
    NodeFs.symlinkSync(target, linked);
    vi.stubEnv("PRKIT_CLI_INSTALL_PATH", NodePath.join(folder, "prkit"));
    const result = await run(home, (installer) => installer.install().pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: `prkit can't use ${linked}: its symlink isn't owned by root.` },
    });
    expect(NodeFs.readdirSync(NodePath.join(target, "bin"))).toEqual([]);
  }));

it("reports an unsafe launcher folder and refuses to install its command", () =>
  withHome(async (home, install) => {
    const target = NodePath.join(home, "target-bin");
    const bin = NodePath.join(home, "bin");
    NodeFs.mkdirSync(target, { mode: 0o700 });
    NodeFs.writeFileSync(NodePath.join(target, "prkit"), "untouched\n");
    NodeFs.rmdirSync(bin);
    NodeFs.symlinkSync(target, bin);
    await run(home, (installer) =>
      Effect.gen(function* () {
        const problem = (yield* installer.get()).launcherProblem;
        expect(problem).toBe(`prkit can't use ${bin}: its symlink isn't owned by root.`);
        expect(yield* installer.install().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "CliInstallError", message: problem },
        });
      }),
    );
    expect(NodeFs.readFileSync(NodePath.join(target, "prkit"), "utf8")).toBe("untouched\n");
    expect(NodeFs.existsSync(install)).toBe(false);
  }));

it("keeps a startup launcher problem visible and refuses install after the folder is repaired", () =>
  withHome(async (home, install) => {
    const problem = "prkit couldn't write its launchers. Restart prkit after fixing the folder.";
    await run(
      home,
      (installer) =>
        Effect.gen(function* () {
          expect((yield* installer.get()).launcherProblem).toBe(problem);
          expect(yield* installer.install().pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "CliInstallError", message: problem },
          });
        }),
      (fs) => fs,
      problem,
    );
    expect(NodeFs.existsSync(install)).toBe(false);
  }));

it.runIf(process.platform === "darwin")(
  "never hands a terminal a path whose control characters it would type as keys",
  () =>
    withHome(async (home) => {
      const tools = NodePath.join(home, "tools");
      const opened = NodePath.join(home, "opened.txt");
      NodeFs.mkdirSync(tools);
      NodeFs.writeFileSync(
        NodePath.join(tools, "osascript"),
        "#!/bin/sh\necho com.apple.Terminal\n",
        {
          mode: 0o700,
        },
      );
      NodeFs.writeFileSync(
        NodePath.join(tools, "open"),
        `#!/bin/sh\nprintf '%s\\n' "$3" >> '${opened}'\n`,
        { mode: 0o700 },
      );
      vi.stubEnv("PRKIT_TERMINAL_BIN", tools);
      const hostile = NodePath.join(home, "x\u0015touch made\rx");
      NodeFs.mkdirSync(hostile, { mode: 0o700 });
      expect(
        await run(hostile, (installer) => installer.openSkillInstaller().pipe(Effect.result)),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "CliInstallError" } });
      expect(NodeFs.existsSync(opened)).toBe(false);
      expect(NodeFs.existsSync(NodePath.join(hostile, "terminal"))).toBe(false);

      expect(await run(home, (installer) => installer.openSkillInstaller())).toEqual({
        terminal: "Terminal",
        isDefault: true,
      });
      const [file = ""] = NodeFs.readFileSync(opened, "utf8").split("\n");
      expect(NodePath.dirname(NodePath.dirname(file))).toBe(NodePath.join(home, "terminal"));
      expect(NodePath.basename(file)).toBe("prkit-skill-installer");
    }),
);
