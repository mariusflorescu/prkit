import type * as NodeChildProcess from "node:child_process";

import type { ServerReadyLine } from "@prkit/contracts";

import { startServer } from "./serverProcess.ts";

type StartOptions = Omit<Parameters<typeof startServer>[0], "port" | "onSpawn">;

/** How long a stopping server gets after SIGTERM before it's killed. */
const STOP_GRACE_MS = 5_000;

/**
 * The one server child this app runs. It can be stopped and started again in place (an update
 * install that didn't happen), and an exit nobody asked for is reported once.
 */
export function createServerSupervisor(options: {
  readonly start: StartOptions;
  readonly onUnexpectedExit: (reason: string) => void;
}) {
  let child: NodeChildProcess.ChildProcess | undefined;
  let stopping = false;

  /** Tracked from the spawn, so Cmd+Q or SIGTERM while it boots still stops it. */
  const track = (spawned: NodeChildProcess.ChildProcess) => {
    child = spawned;
    let ready = false;
    spawned.once("exit", (code, signal) => {
      if (child === spawned) child = undefined;
      // An exit while booting rejects `start`, which reports it.
      if (ready && !stopping) options.onUnexpectedExit(signal ?? `code ${code}`);
    });
    return () => {
      ready = true;
    };
  };

  const start = async (port: number): Promise<ServerReadyLine> => {
    stopping = false;
    let markReady = () => {};
    const started = await startServer({
      ...options.start,
      port,
      onSpawn: (spawned) => {
        markReady = track(spawned);
      },
    });
    markReady();
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
