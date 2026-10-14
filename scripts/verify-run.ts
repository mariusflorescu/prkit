/**
 * The run file: what scripts/verify-app.ts records about one verification
 * instance, and what tests, the doctor and cleanup read back. Everything an
 * instance owns lives under `.e2e/`, keyed by its name.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const e2eDir = NodePath.join(repoRoot, ".e2e");
const runDir = NodePath.join(e2eDir, "run");

export const RunFile = Schema.Struct({
  name: Schema.String,
  /** The supervisor. Signal this one to stop the instance. */
  pid: Schema.Int,
  serverPid: Schema.Int,
  port: Schema.Int,
  url: Schema.String,
  /** `url` plus the session token: the address a browser opens first. */
  openUrl: Schema.String,
  token: Schema.String,
  home: Schema.String,
  log: Schema.String,
});
export type RunFile = typeof RunFile.Type;

const RunFileJson = Schema.fromJsonString(RunFile);
const decodeRunFile = Schema.decodeUnknownOption(RunFileJson);
const encodeRunFile = Schema.encodeSync(RunFileJson);

const ServerPackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const BuildJson = Schema.fromJsonString(Schema.Struct({ buildId: Schema.String }));
const Health = Schema.Struct({ ok: Schema.Boolean, home: Schema.String, buildId: Schema.String });

export const readHealth = async (url: string, timeoutMs = 200) => {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200) throw new Error(`Health returned HTTP ${response.status}`);
  return Schema.decodeUnknownSync(Health)(await response.json());
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

export const instancePaths = (name: string) => ({
  runFile: NodePath.join(runDir, `${name}.json`),
  home: NodePath.join(e2eDir, "homes", name),
  log: NodePath.join(e2eDir, "logs", `${name}.log`),
});

export const serverVersion = (): string =>
  Schema.decodeSync(ServerPackageJson)(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
  ).version;

export const serverBuildId = (): string =>
  Schema.decodeSync(BuildJson)(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/dist/build.json"), "utf8"),
  ).buildId;

const readRunFile = (path: string): Option.Option<RunFile> => {
  try {
    return decodeRunFile(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return Option.none();
  }
};

export const readRun = (name: string): Option.Option<RunFile> =>
  readRunFile(instancePaths(name).runFile);

export const listRuns = (): Array<RunFile> => {
  if (!NodeFS.existsSync(runDir)) return [];
  return NodeFS.readdirSync(runDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => Option.toArray(readRunFile(NodePath.join(runDir, file))));
};

/** Written to a temp file and renamed, so a reader never sees half a run file. */
export const writeRun = (run: RunFile): void => {
  const path = instancePaths(run.name).runFile;
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(`${path}.tmp`, `${encodeRunFile(run)}\n`);
  NodeFS.renameSync(`${path}.tmp`, path);
};

/** The instance serving `url` (an e2e target's `app.baseUrl`), found by its port. */
export const runForUrl = (url: string | undefined): RunFile => {
  const port = Number(new URL(url ?? "http://127.0.0.1").port);
  const run = listRuns().find((candidate) => candidate.port === port);
  if (run === undefined) {
    throw new Error(
      `no run file in .e2e/run/ for port ${port}; was the app started by verify-app?`,
    );
  }
  return run;
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * True when `pid` is alive and still runs the command we recorded it for.
 * A run file left by a crash can name a pid the OS has since given to
 * something else; that process is never ours to signal.
 */
export const isOurProcess = (pid: number, commandFragment: string): boolean => {
  if (!isAlive(pid)) return false;
  try {
    return NodeChildProcess.execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).includes(commandFragment);
  } catch {
    return false;
  }
};

export const SUPERVISOR_COMMAND = "scripts/verify-app.ts";
export const SERVER_COMMAND = "apps/server/dist/bin.mjs";

/** The run's processes that are alive and still ours, supervisor first. */
export const liveProcesses = (run: RunFile): Array<number> =>
  [
    { pid: run.pid, command: SUPERVISOR_COMMAND },
    { pid: run.serverPid, command: SERVER_COMMAND },
  ]
    .filter(({ pid, command }) => isOurProcess(pid, command))
    .map(({ pid }) => pid);
