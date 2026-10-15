import { childEnv, CliInstallError, type CliInstallState } from "@prkit/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Uninstall needs lstat and empty-directory-only cleanup, which FileSystem does not expose.
import * as NodeFs from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shellQuote } from "../outside/launcher.ts";
import { OutsideAgents } from "../outside/OutsideAgents.ts";
import { ServerConfig } from "../config.ts";
import { trustedFolderProblem } from "../trustedFolder.ts";
import { skillBuild } from "./skillBuild.ts";
import { skillInstallCommand, skillTerminalScript } from "./skillCommand.ts";

export class CliInstall extends Context.Service<CliInstall, Effect.Success<typeof make>>()(
  "@prkit/server/cli/CliInstall",
) {}

export const preferredInstallDirectory = (preferred: string, fallback: string) =>
  Effect.gen(function* () {
    return (yield* trustedFolderProblem(preferred)) === null ? preferred : fallback;
  });

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const outsideAgents = yield* OutsideAgents;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const writing = yield* Semaphore.make(1);
  const launcher = path.join(config.home, "bin", "prkit");
  const skillCommand = skillInstallCommand(skillBuild.repository, skillBuild.ref);
  const fail = (message: string) => Effect.fail(new CliInstallError({ message }));
  const requireDirectory = (directory: string, allowMissing = false) =>
    trustedFolderProblem(directory, { allowMissing }).pipe(
      Effect.flatMap((problem) => (problem === null ? Effect.void : fail(problem))),
    );
  const location = Effect.gen(function* () {
    const override = process.env.PRKIT_CLI_INSTALL_PATH;
    if (override !== undefined) {
      if (!path.isAbsolute(override) || path.basename(override) !== "prkit")
        return yield* fail("PRKIT_CLI_INSTALL_PATH must be an absolute file path ending in prkit.");
      const file = path.normalize(override);
      yield* requireDirectory(path.dirname(file), true);
      return file;
    }
    const fallback = path.join(process.env.HOME ?? "", ".local", "bin");
    const directory =
      process.platform === "darwin"
        ? yield* preferredInstallDirectory("/usr/local/bin", fallback)
        : fallback;
    yield* requireDirectory(directory, true);
    return path.join(directory, "prkit");
  });

  const get = () =>
    Effect.gen(function* () {
      const file = yield* location;
      const directory = path.dirname(file);
      const linked = yield* fs.readLink(file).pipe(
        Effect.map((target) => ({ target, exists: true })),
        Effect.catchTag("PlatformError", (error) => {
          if (error.reason._tag === "NotFound")
            return Effect.succeed({ target: null, exists: false });
          if (error.reason._tag === "BadResource" || error.reason._tag === "BadArgument")
            return Effect.succeed({ target: null, exists: true });
          // Node's EINVAL (a regular file) is currently mapped to Unknown by the platform.
          if (
            Option.isSome(
              Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal("EINVAL") }))(
                error.cause,
              ),
            )
          )
            return Effect.succeed({ target: null, exists: true });
          return Effect.fail(error);
        }),
      );
      const systemPath =
        process.platform === "darwin"
          ? yield* fs
              .readFileString("/etc/paths")
              .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")))
          : "";
      const processPath = (process.env.PATH ?? "").split(path.sep === "\\" ? ";" : ":");
      const has = (paths: string[]) =>
        paths.some((entry) => entry !== "" && path.resolve(entry.trim()) === directory);
      const pathSource = has(processPath)
        ? "process"
        : has(systemPath.split(/\r?\n/))
          ? "system"
          : "missing";
      const owned = linked.target !== null && path.resolve(directory, linked.target) === launcher;
      return {
        path: file,
        launcher,
        launcherProblem:
          outsideAgents.launcherProblem() ?? (yield* trustedFolderProblem(path.dirname(launcher))),
        status: owned ? "installed" : linked.exists ? "foreign" : "absent",
        existing:
          linked.exists && !owned
            ? linked.target === null
              ? "An existing file or directory"
              : `A link to ${linked.target}`
            : null,
        pathSource,
        pathCommand: `export PATH=${shellQuote(directory)}:"$PATH"`,
        skillCommand,
      } satisfies CliInstallState;
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        fail(
          "prkit couldn't inspect the command line installation. Check the folder's permissions and retry.",
        ),
      ),
    );

  const change = (install: boolean) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* get();
        if (install && state.launcherProblem !== null) return yield* fail(state.launcherProblem);
        if (state.status === "foreign")
          return yield* fail(
            `${state.existing} is at ${state.path}. prkit left it alone. Move it yourself before installing.`,
          );
        if (install && state.status === "absent") {
          yield* fs.makeDirectory(path.dirname(state.path), { recursive: true, mode: 0o755 });
          yield* requireDirectory(path.dirname(state.path));
          // symlink is exclusive: a file appearing after get() is never overwritten.
          yield* fs.symlink(launcher, state.path);
        } else if (!install && state.status === "installed") {
          const temporary = yield* fs.makeTempDirectory({
            directory: path.dirname(state.path),
            prefix: ".prkit-uninstall-",
          });
          const moved = path.join(temporary, "prkit");
          let needsRestore = false;
          const restoreFailure = (reason: string) =>
            fail(
              `prkit couldn't restore ${state.path}: ${reason}. The moved entry is preserved at ${moved}. To put it back, run: mv ${shellQuote(moved)} ${shellQuote(state.path)}`,
            );
          const restore = Effect.gen(function* () {
            if (!needsRestore) return;
            needsRestore = false;
            const info = yield* Effect.tryPromise({
              try: () => NodeFs.lstat(moved),
              catch: () =>
                new CliInstallError({
                  message: "the moved entry couldn't be inspected",
                }),
            });
            if (info.isFile()) yield* fs.link(moved, state.path);
            else if (info.isSymbolicLink())
              yield* fs.symlink(yield* fs.readLink(moved), state.path);
            else return yield* fail("the moved entry is not a regular file or a symlink");
            yield* fs.remove(moved);
          }).pipe(
            Effect.catchTags({
              PlatformError: () => restoreFailure("the recovery operation failed"),
              CliInstallError: (error) => restoreFailure(error.message),
            }),
          );
          yield* Effect.gen(function* () {
            yield* fs.rename(state.path, moved);
            needsRestore = true;
            const info = yield* Effect.tryPromise({
              try: () => NodeFs.lstat(moved),
              catch: () => new CliInstallError({ message: `prkit couldn't inspect ${moved}.` }),
            });
            const own =
              info.isSymbolicLink() &&
              path.resolve(path.dirname(state.path), yield* fs.readLink(moved)) === launcher;
            if (!own) {
              yield* restore;
              return yield* fail(
                `${state.path} changed during uninstall. prkit restored it and left it alone.`,
              );
            }
            yield* fs.remove(moved);
            needsRestore = false;
          }).pipe(
            Effect.catchTags({
              PlatformError: (error) => restore.pipe(Effect.andThen(Effect.fail(error))),
              CliInstallError: (error) => restore.pipe(Effect.andThen(Effect.fail(error))),
            }),
            Effect.ensuring(
              Effect.tryPromise({
                try: () => NodeFs.rmdir(temporary),
                catch: () => new CliInstallError({ message: `prkit left ${temporary} alone.` }),
              }).pipe(Effect.ignore),
            ),
            Effect.uninterruptible,
          );
        }
        return yield* get();
      }).pipe(
        Effect.catchTag("PlatformError", () =>
          fail(
            "prkit couldn't change its command line link. Check the folder's permissions and retry. No administrator access is needed.",
          ),
        ),
      ),
    );

  const openSkillInstaller = () =>
    Effect.gen(function* () {
      if (skillCommand === null)
        return yield* fail(
          "This build has no skill repository. Install a release build, or build with GITHUB_REPOSITORY set.",
        );
      if (process.platform !== "darwin")
        return yield* fail("Copy the command and run it in your terminal.");
      yield* spawner
        .exitCode(
          ChildProcess.make(
            process.env.PRKIT_TERMINAL_PATH ?? "/usr/bin/osascript",
            ["-e", skillTerminalScript(skillCommand)],
            { env: childEnv(process.env) },
          ),
        )
        .pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : fail("prkit couldn't open Terminal. Copy the command and run it there."),
          ),
          Effect.catchTag("PlatformError", () =>
            fail("prkit couldn't open Terminal. Copy the command and run it there."),
          ),
        );
    });
  return { get, install: () => change(true), uninstall: () => change(false), openSkillInstaller };
});

export const layer = Layer.effect(CliInstall, make);
