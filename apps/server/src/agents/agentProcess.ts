import { childEnv } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * When the process with this PID started, as `ps` prints it, or null if there is
 * none. A PID plus its start time names one process even after the PID is reused.
 */
export const processStartTime = (pid: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)], {
          env: childEnv(process.env),
          extendEnv: false,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      const started = output.trim();
      return (yield* child.exitCode) === 0 && started !== "" ? started : null;
    }),
  ).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)));

/**
 * Kills the process group an agent ran in, but only if its leader is still the
 * process prkit started: same PID and same start time. Agents run in their own
 * group, so this also ends the commands they started.
 */
export const reapAgentGroup = (pid: number, startedAt: string) =>
  Effect.gen(function* () {
    if ((yield* processStartTime(pid)) !== startedAt) return false;
    return yield* Effect.sync(() => {
      try {
        process.kill(-pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    });
  });
