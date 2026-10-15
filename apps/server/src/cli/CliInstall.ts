import { childEnv, CliInstallError, type CliInstallState } from "@prkit/contracts";
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
import { ServerConfig } from "../config.ts";
import { skillBuild } from "./skillBuild.ts";
import { skillInstallCommand, skillTerminalScript } from "./skillCommand.ts";

export class CliInstall extends Context.Service<CliInstall, Effect.Success<typeof make>>()(
  "@prkit/server/cli/CliInstall",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const writing = yield* Semaphore.make(1);
  const launcher = path.join(config.home, "bin", "prkit");
  const skillCommand = skillInstallCommand(skillBuild.repository, skillBuild.ref);
  const fail = (message: string) => Effect.fail(new CliInstallError({ message }));
  const location = Effect.gen(function* () {
    const override = process.env.PRKIT_CLI_INSTALL_PATH;
    if (override !== undefined) {
      if (!path.isAbsolute(override) || path.basename(override) !== "prkit")
        return yield* fail("PRKIT_CLI_INSTALL_PATH must be an absolute file path ending in prkit.");
      return path.normalize(override);
    }
    const local = "/usr/local/bin";
    const writable =
      process.platform === "darwin" &&
      (yield* fs.access(local, { writable: true }).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", () => Effect.succeed(false)),
      ));
    return writable
      ? path.join(local, "prkit")
      : path.join(process.env.HOME ?? "", ".local", "bin", "prkit");
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
        if (state.status === "foreign")
          return yield* fail(
            `${state.existing} is at ${state.path}. prkit left it alone. Move it yourself before installing.`,
          );
        if (install && state.status === "absent") {
          yield* fs.makeDirectory(path.dirname(state.path), { recursive: true });
          // symlink is exclusive: a file appearing after get() is never overwritten.
          yield* fs.symlink(launcher, state.path);
        } else if (!install && state.status === "installed") {
          yield* fs.remove(state.path);
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
