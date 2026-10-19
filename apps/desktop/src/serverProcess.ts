import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import {
  childEnv,
  ServerHomeInUseLineJson,
  type ServerReadyLine,
  ServerReadyLineJson,
} from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const READY_TIMEOUT_MS = 20_000;
const decodeReadyLine = Schema.decodeUnknownOption(ServerReadyLineJson);
const decodeHomeInUseLine = Schema.decodeUnknownOption(ServerHomeInUseLineJson);

export interface ServerProcess {
  readonly child: NodeChildProcess.ChildProcess;
  readonly ready: ServerReadyLine;
}

export type ServerTarget =
  | { readonly _tag: "Built"; readonly webDist: string }
  | { readonly _tag: "DevWeb"; readonly webOrigin: string };

/**
 * Runs the built server on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`) and resolves
 * with the ready line it prints. The token reaches the child through its env only.
 */
export function startServer(options: {
  readonly entry: string;
  readonly home: string;
  readonly token: string;
  readonly port: number;
  readonly target: ServerTarget;
  /** The server's working directory; the caller's when absent. */
  readonly cwd?: string;
  /** The packaged app's version, for the server to report; its own when absent. */
  readonly appVersion?: string;
  /** Called with the child as soon as it exists, before it's ready, so it can be stopped while booting. */
  readonly onSpawn?: (child: NodeChildProcess.ChildProcess) => void;
}): Promise<ServerProcess> {
  const targetArgs =
    options.target._tag === "Built"
      ? ["--web-dist", options.target.webDist]
      : ["--dev-web-origin", options.target.webOrigin];
  const child = NodeChildProcess.spawn(
    process.execPath,
    [options.entry, "--port", String(options.port), ...targetArgs],
    {
      env: childEnv(process.env, {
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
        PRKIT_GH_PATH: process.env.PRKIT_GH_PATH,
        PRKIT_GITHUB_API_URL: process.env.PRKIT_GITHUB_API_URL,
        ELECTRON_RUN_AS_NODE: "1",
        PRKIT_HOME: options.home,
        PRKIT_AUTH_TOKEN: options.token,
        PRKIT_APP_VERSION: options.appVersion,
      }),
      stdio: ["ignore", "pipe", "inherit"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
  );
  options.onSpawn?.(child);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The server did not report ready within ${READY_TIMEOUT_MS / 1000}s.`));
    }, READY_TIMEOUT_MS);
    const settle = () => {
      clearTimeout(timer);
      lines.close();
    };
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const ready = decodeReadyLine(line);
      if (Option.isSome(ready)) {
        settle();
        resolve({ child, ready: ready.value });
        return;
      }
      const inUse = decodeHomeInUseLine(line);
      if (Option.isSome(inUse)) {
        settle();
        reject(
          new Error(
            `Another prkit is already running with the data folder ${inUse.value.home}. Quit it, then open this one again.`,
          ),
        );
        return;
      }
      process.stdout.write(`[server] ${line}\n`);
    });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      settle();
      reject(new Error(`The server exited before it was ready (${signal ?? `code ${code}`}).`));
    });
  });
}
