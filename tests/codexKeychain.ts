import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { childEnv } from "../packages/contracts/src/childEnv.ts";

export const KEYCHAIN_RUNS = process.env.PRKIT_E2E_CODEX_KEYCHAIN === "1";
export const KEYCHAIN_SKIP =
  "Adds throwaway keychain entries. Run with CODEX_HOME=<empty folder under .e2e/> PRKIT_E2E_CODEX_KEYCHAIN=1.";

const scratch = NodePath.resolve(import.meta.dirname, "../.e2e");
const codex = process.env.PRKIT_CODEX_PATH ?? "codex";

/** The Codex home the server was started with, refused unless it is a scratch folder under `.e2e/`. */
export const scratchCodexHome = () => {
  const home = NodePath.resolve(process.env.CODEX_HOME ?? "");
  if (!home.startsWith(`${scratch}${NodePath.sep}`))
    throw new Error("CODEX_HOME must be a scratch folder under .e2e/, never your own Codex home.");
  return home;
};

/**
 * Signs a scratch Codex home in the way a keychain user is: config.toml asks for the keyring,
 * and the login is a made-up API key, so the entry holds no real credential.
 */
export const signInThroughKeychain = (home: string) => {
  NodeFS.writeFileSync(
    NodePath.join(home, "config.toml"),
    'cli_auth_credentials_store = "keyring"\n',
  );
  NodeChildProcess.execFileSync(codex, ["login", "--with-api-key"], {
    input: "sk-prkit-e2e-not-a-key",
    env: childEnv(process.env, { CODEX_HOME: home }),
    stdio: ["pipe", "ignore", "ignore"],
  });
};

/** Signs a scratch Codex home in with a login file holding a made-up API key. */
export const signInThroughFile = (home: string) => {
  NodeFS.rmSync(NodePath.join(home, "config.toml"), { force: true });
  NodeChildProcess.execFileSync(codex, ["login", "--with-api-key"], {
    input: "sk-prkit-e2e-not-a-key",
    env: childEnv(process.env, { CODEX_HOME: home }),
    stdio: ["pipe", "ignore", "ignore"],
  });
};

/** Whether Codex in `home` finds a login, in `store` when given, from the exit code alone. */
export const signedIn = (home: string, store?: "keyring") =>
  NodeChildProcess.spawnSync(
    codex,
    [
      ...(store === undefined ? [] : ["-c", `cli_auth_credentials_store="${store}"`]),
      "login",
      "status",
    ],
    { env: childEnv(process.env, { CODEX_HOME: home }), stdio: "ignore" },
  ).status === 0;

/** Whether something on this machine accepts connections on `port`, such as Codex's login server. */
export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Takes `ports` on 127.0.0.1 the way another program would, until the returned call frees them. */
export const holdPorts = async (ports: ReadonlyArray<number>) => {
  const servers = await Promise.all(
    ports.map(
      (port) =>
        new Promise<NodeNet.Server>((resolve, reject) => {
          // Codex connects to a taken port to cancel what it takes for its own old login
          // server; an open connection would keep `close` waiting.
          const server = NodeNet.createServer((socket) => socket.destroy());
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => resolve(server));
        }),
    ),
  );
  return () =>
    Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
};

/** What prkit's Codex home holds for its login: where its auth.json links, and its config. */
export const loginFiles = (prkitCodexHome: string) => {
  const link = NodePath.join(prkitCodexHome, "auth.json");
  const config = NodePath.join(prkitCodexHome, "config.toml");
  return {
    authJson: NodeFS.lstatSync(link, { throwIfNoEntry: false })
      ? NodeFS.readlinkSync(link)
      : "absent",
    config: NodeFS.existsSync(config) ? NodeFS.readFileSync(config, "utf8") : "absent",
  };
};

/**
 * Removes a scratch home's keychain entry, its auth.json (a link only removed, never followed)
 * and its config.
 */
export const signOutOfKeychain = (home: string) => {
  NodeChildProcess.spawnSync(codex, ["-c", 'cli_auth_credentials_store="keyring"', "logout"], {
    env: childEnv(process.env, { CODEX_HOME: home }),
    stdio: "ignore",
  });
  NodeFS.rmSync(NodePath.join(home, "config.toml"), { force: true });
};
