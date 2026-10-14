import type * as NodeChildProcess from "node:child_process";

import type { ServerReadyLine } from "@prkit/contracts";

import { startServer } from "./serverProcess.ts";

type StartOptions = Parameters<typeof startServer>[0];

/** How long a stopping server gets after SIGTERM before it's killed. */
const STOP_GRACE_MS = 5_000;

/**
 * The one server child this app runs. It can be stopped and started again in place (an update
 * install that didn't happen), and an exit nobody asked for is reported once.
 */
export function createServerSupervisor(options: {
  readonly start: Omit<StartOptions, "port">;
  readonly onUnexpectedExit: (reason: string) => void;
}) {
  let child: NodeChildProcess.ChildProcess | undefined;
  let stopping = false;

  const watch = (started: NodeChildProcess.ChildProcess) => {
    started.once("exit", (code, signal) => {
      if (child === started) child = undefined;
      if (!stopping) options.onUnexpectedExit(signal ?? `code ${code}`);
    });
  };

  const start = async (port: number): Promise<ServerReadyLine> => {
    stopping = false;
    const started = await startServer({ ...options.start, port });
    child = started.child;
    watch(started.child);
    return started.ready;
  };

  /** SIGTERM, then SIGKILL after the grace; resolves once the child has exited. */
  const stop = () =>
    new Promise<void>((resolve) => {
      stopping = true;
      const running = child;
      if (running === undefined || running.exitCode !== null || running.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => running.kill("SIGKILL"), STOP_GRACE_MS);
      running.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      // Only the child this process spawned, by its handle.
      running.kill("SIGTERM");
    });

  /** For quitting: no wait, the operating system reaps the child after this process ends. */
  const signalStop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };

  return { start, stop, signalStop, pid: () => child?.pid };
}
