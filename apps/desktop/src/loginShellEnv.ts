import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { childEnv } from "@prkit/contracts";

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/** Where gh keeps its logins: `GH_CONFIG_DIR`, else `gh` in `XDG_CONFIG_HOME`, else in ~/.config. */
const GH_NAMES = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;
const NAMES = ["PATH", ...GH_NAMES] as const;
type Name = (typeof NAMES)[number];
const marker = (name: string) => `__PRKIT_${name}__`;
const END = marker("END");
const PROBE = [
  ...NAMES.map((name) => `printf '%s\\n' '${marker(name)}'; printenv ${name}`),
  `printf '%s\\n' '${END}'`,
].join("; ");

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
 * `printenv` prints nothing for a variable the shell doesn't set, so the line after its marker
 * is the next marker.
 */
const parse = (output: string) => {
  const lines = output.split("\n").map((line) => line.trim());
  const end = lines.lastIndexOf(END);
  if (end === -1) return undefined;
  const values = new Map<Name, string>();
  for (const name of NAMES) {
    const at = lines.lastIndexOf(marker(name), end);
    const value = at === -1 ? undefined : lines[at + 1];
    if (value !== undefined && value !== "" && !value.startsWith("__PRKIT_"))
      values.set(name, value);
  }
  return values;
};

/**
 * Runs `<shell> -ilc` so the user's profile and rc files set the environment up the way a
 * terminal would. Only `NAMES` are read back: the markers keep rc-file chatter out of them.
 * The shell gets the child allowlist, not the whole environment, and stdin closed so nothing
 * can wait on it.
 */
const readLoginEnv = (shell: string, env: NodeJS.ProcessEnv) =>
  new Promise<ReadonlyMap<Name, string> | undefined>((resolve) => {
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
      resolve(parse(output));
    });
  });

const mergePaths = (...paths: ReadonlyArray<string | undefined>) =>
  [
    ...new Set(paths.flatMap((path) => (path ?? "").split(":")).filter((entry) => entry !== "")),
  ].join(":");

/**
 * A GUI app started from the Dock or Finder gets launchd's environment: PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so `gh`, `git`, `claude` and `codex` would not resolve, and
 * none of the user's shell variables are set, so prkit would miss gh logins kept under
 * `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` even though `gh` finds them in a terminal. This puts
 * the login shell's PATH in front of the current one in `env`. The shell's `GH_CONFIG_DIR`
 * and `XDG_CONFIG_HOME` come as a pair, and only when `env` has neither: taking one beside a
 * launch's own other would make a directory win that neither setup picks. A relative value is
 * left out, since the server runs in another folder than the shell. It leaves `env` as it was
 * when no shell answers within the timeout. Nothing else is read from the shell. Returns a
 * line for the launch log.
 */
export const hydrateFromLoginShell = async (env: NodeJS.ProcessEnv = process.env) => {
  if (process.platform === "win32") return "skipped on Windows";
  const started = Date.now();
  for (const shell of shellCandidates(env.SHELL)) {
    if (Date.now() - started >= LOGIN_SHELL_TIMEOUT_MS) break;
    const values = await readLoginEnv(shell, env);
    const loginPath = values?.get("PATH");
    if (values === undefined || loginPath === undefined) continue;
    env.PATH = mergePaths(loginPath, env.PATH);
    const own = GH_NAMES.some((name) => (env[name] ?? "") !== "");
    const taken = own
      ? []
      : GH_NAMES.filter((name) => {
          const value = values.get(name);
          if (value === undefined || !NodePath.isAbsolute(value)) return false;
          env[name] = value;
          return true;
        });
    return `read ${["PATH", ...taken].join(", ")} from ${shell} in ${Date.now() - started}ms`;
  }
  return `no login shell answered in ${Date.now() - started}ms, keeping the current PATH`;
};
