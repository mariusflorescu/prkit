/**
 * `dev`: server (node --watch) + Vite. Prints the URL to open, token included.
 * `dev:desktop`: builds the server and desktop main, starts Vite, then Electron,
 * which owns the server child and opens the window itself.
 *
 * State lives in this checkout's gitignored `.prkit/`. Each child runs in its own
 * process group and is stopped through that group (`vp dev` and `node --watch` fork
 * workers that would otherwise outlive them), never by pattern.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { childEnv, ServerHomeInUseLineJson, ServerReadyLineJson } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const MODES = ["dev", "dev:desktop"] as const;
type Mode = (typeof MODES)[number];

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const vp = NodePath.join(repoRoot, "node_modules/.bin/vp");
const decodeReadyLine = Schema.decodeUnknownOption(ServerReadyLineJson);
const decodeHomeInUseLine = Schema.decodeUnknownOption(ServerHomeInUseLineJson);

const isMode = (value: string | undefined): value is Mode => MODES.some((mode) => mode === value);

const log = (message: string) => process.stdout.write(`[dev-runner] ${message}\n`);

/** Binds port 0 on loopback and hands back what the OS picked. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });

const waitForHttp = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
};

const children = new Set<NodeChildProcess.ChildProcess>();

const spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
): NodeChildProcess.ChildProcess => {
  const child = NodeChildProcess.spawn(command, args, { ...options, detached: true });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      log(`${NodePath.basename(command)} exited (${signal ?? code}); stopping the rest`);
      void shutdown(code ?? 1);
    }
  });
  return child;
};

let shuttingDown = false;
const stopGroup = (child: NodeChildProcess.ChildProcess) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The group is already gone.
  }
};

const shutdown = async (exitCode: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopGroup(child);
  await Promise.all(
    [...children].map((child) => new Promise((resolve) => child.once("exit", resolve))),
  );
  process.exit(exitCode);
};
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// Children get childEnv() plus what they need: no caller PRKIT_*, GH tokens, or an
// inherited ELECTRON_RUN_AS_NODE (which would boot Electron as plain Node).
const baseEnv = childEnv(process.env);

const startVite = (ports: { serverPort: number; webPort: number }) =>
  spawn(vp, ["dev"], {
    cwd: NodePath.join(repoRoot, "apps/web"),
    env: {
      ...baseEnv,
      PRKIT_SERVER_PORT: String(ports.serverPort),
      PRKIT_WEB_PORT: String(ports.webPort),
    },
    stdio: "inherit",
  });

const runDev = async (base: { home: string; serverPort: number; webPort: number }) => {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const webOrigin = `http://127.0.0.1:${base.webPort}`;
  const server = spawn(
    process.execPath,
    [
      "--watch",
      "apps/server/src/bin.ts",
      "--port",
      String(base.serverPort),
      "--dev-web-origin",
      webOrigin,
      ...(process.env.PRKIT_LOG_LEVEL ? ["--log-level", process.env.PRKIT_LOG_LEVEL] : []),
    ],
    {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        PRKIT_GH_PATH: process.env.PRKIT_GH_PATH,
        PRKIT_HOME: base.home,
        PRKIT_AUTH_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const firstReady = new Promise<void>((resolve) => {
    if (!server.stdout) return;
    NodeReadline.createInterface({ input: server.stdout }).on("line", (line) => {
      const ready = decodeReadyLine(line);
      if (Option.isSome(ready)) {
        log(`server ready on ${ready.value.url}`);
        resolve();
        return;
      }
      // `node --watch` would wait for a file change; another prkit owns this home.
      const inUse = decodeHomeInUseLine(line);
      if (Option.isSome(inUse)) {
        log(`another prkit is already using ${inUse.value.home}; quit it, then run this again`);
        void shutdown(1);
        return;
      }
      process.stdout.write(`${line}\n`);
    });
  });
  startVite(base);
  await Promise.all([firstReady, waitForHttp(webOrigin, 30_000)]);
  log(`prkit: ${webOrigin}/?token=${token}`);
};

const runDevDesktop = async (base: { home: string; serverPort: number; webPort: number }) => {
  const webOrigin = `http://127.0.0.1:${base.webPort}`;
  for (const app of ["apps/server", "apps/desktop"]) {
    NodeChildProcess.execFileSync(vp, ["pack"], {
      cwd: NodePath.join(repoRoot, app),
      stdio: "inherit",
    });
  }
  startVite(base);
  await waitForHttp(webOrigin, 30_000);
  const electron = NodePath.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  spawn(electron, ["."], {
    cwd: NodePath.join(repoRoot, "apps/desktop"),
    env: {
      ...baseEnv,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      PRKIT_GH_PATH: process.env.PRKIT_GH_PATH,
      PRKIT_HOME: base.home,
      PRKIT_DEV_WEB_URL: webOrigin,
      PRKIT_SERVER_PORT: String(base.serverPort),
    },
    stdio: "inherit",
  });
  log(`electron started; its window loads ${webOrigin}`);
};

const mode = process.argv[2];
if (!isMode(mode)) {
  process.stderr.write(`usage: node scripts/dev-runner.ts <${MODES.join("|")}>\n`);
  process.exit(2);
}

const serverPort = await freePort();
const webPort = await freePort();
const base = { home: NodePath.join(repoRoot, ".prkit"), serverPort, webPort };
log(`mode=${mode} home=${base.home} serverPort=${serverPort} webPort=${webPort}`);
await (mode === "dev" ? runDev(base) : runDevDesktop(base)).catch((error: Error) => {
  log(`failed: ${error.message}`);
  return shutdown(1);
});
