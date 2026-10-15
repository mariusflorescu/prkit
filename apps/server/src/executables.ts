import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Version-manager shims re-export environment computed from the cwd, so prkit runs the real binary. */
export const isShim = (value: string) => value.replaceAll("\\", "/").split("/").includes("shims");

/** The real path of an executable file outside any shim dir, or null. */
export const executableAt = (input: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(input) || isShim(input)) return null;
    const resolved = yield* fs.realPath(input);
    if (isShim(resolved)) return null;
    const info = yield* fs.stat(resolved);
    if (info.type !== "File") return null;
    if (process.platform !== "win32" && (info.mode & 0o111) === 0) return null;
    return resolved;
  }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)));

/** The first executable named `name` on PATH, skipping shim dirs. */
export const findOnPath = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const searchPath = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
    const file = process.platform === "win32" ? `${name}.exe` : name;
    for (const directory of searchPath) {
      if (directory === "" || isShim(directory)) continue;
      const found = yield* executableAt(path.resolve(directory, file));
      if (found) return found;
    }
    return null;
  });

/** `~` and `~/...` in a path the user typed, as their home folder. */
export const expandHome = (input: string) =>
  input === "~" ? NodeOS.homedir() : input.startsWith("~/") ? `${NodeOS.homedir()}${input.slice(1)}` : input;

/**
 * An agent's binary: the instance's own path, else the server's override (`PRKIT_CLAUDE_PATH`,
 * `PRKIT_CODEX_PATH`), else the first on PATH. Looked up on every call, so Check again finds
 * an agent installed while prkit runs.
 */
export const agentBinary = (binaryPath: string | null, override: string | undefined, name: string) =>
  binaryPath !== null
    ? executableAt(binaryPath)
    : override !== undefined
      ? executableAt(override)
      : findOnPath(name);
