import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { childEnv } from "@prkit/contracts";

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const START = "__PRKIT_PATH_START__";
const END = "__PRKIT_PATH_END__";
const PROBE = `printf '%s\\n' '${START}'; printenv PATH; printf '%s\\n' '${END}'`;

const trimmed = (value: string | undefined) => {
  const text = value?.trim();
  return text === undefined || text === "" ? [] : [text];
};

const userShell = () => {
  try {
    return trimmed(NodeOS.userInfo().shell ?? undefined);
  } catch {
    return [];
  }
};

/** The shell the user is logged in with, then the platform default. */
const shellCandidates = (shell: string | undefined) => [
  ...new Set([
    ...trimmed(shell),
    ...userShell(),
    ...(process.platform === "darwin" ? ["/bin/zsh"] : ["/bin/bash"]),
  ]),
];

/**
 * Runs `<shell> -ilc` so the user's profile and rc files set PATH up the way a terminal
 * would. Only PATH is read back: the markers keep rc-file chatter out of it. The shell gets
 * the child allowlist, not the whole environment, and stdin closed so nothing can wait on it.
 */
const readPath = (shell: string, env: NodeJS.ProcessEnv) =>
  new Promise<string | undefined>((resolve) => {
    let output = "";
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(shell, ["-ilc", PROBE], {
        env: childEnv(env),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_SHELL_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const start = output.indexOf(START);
      const end = output.indexOf(END, start);
      const value = start === -1 || end === -1 ? "" : output.slice(start + START.length, end);
      resolve(trimmed(value)[0]);
    });
  });

const mergePaths = (...paths: ReadonlyArray<string | undefined>) =>
  [
    ...new Set(paths.flatMap((path) => (path ?? "").split(":")).filter((entry) => entry !== "")),
  ].join(":");

/**
 * A GUI app started from the Dock or Finder gets launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * so `gh`, `git`, `claude` and `codex` would not resolve even though a terminal finds them.
 * This puts the login shell's PATH in front of the current one in `env`, and leaves `env`
 * as it was when no shell answers within the timeout. Nothing else is read from the shell.
 * Returns a line for the launch log.
 */
export const hydratePathFromLoginShell = async (env: NodeJS.ProcessEnv = process.env) => {
  if (process.platform === "win32") return "skipped on Windows";
  const started = Date.now();
  for (const shell of shellCandidates(env.SHELL)) {
    if (Date.now() - started >= LOGIN_SHELL_TIMEOUT_MS) break;
    const loginPath = await readPath(shell, env);
    if (loginPath === undefined) continue;
    env.PATH = mergePaths(loginPath, env.PATH);
    return `read from ${shell} in ${Date.now() - started}ms`;
  }
  return `no login shell answered in ${Date.now() - started}ms, keeping the current PATH`;
};
