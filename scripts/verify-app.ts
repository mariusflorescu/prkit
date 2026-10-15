/**
 * Runs isolated prkit instances for verification: the built server serving the
 * built UI, with its own home under `.e2e/homes/<name>`, a fresh session token,
 * and a run file at `.e2e/run/<name>.json` that tests, the doctor and cleanup
 * read. Builds nothing; run `pnpm build` first.
 *
 *   node scripts/verify-app.ts start  [--name verify] [--port 0] [--rm] [--detach] [--watch-interval <ms>]
 *                                     [--dev-review-requested <pr key>] [--e2e]
 *                                     [--github-api <url> --gh-home <dir>] [--claude <file>]
 *   node scripts/verify-app.ts doctor [--name <name>]
 *   node scripts/verify-app.ts stop   [--name verify] [--keep-home]
 *
 * `start` stays in the foreground and stops its server on SIGINT, SIGTERM or
 * SIGHUP; `--detach` returns once the instance answers. `--rm` starts from an
 * empty home and deletes it on exit. Server logs go to `.e2e/logs/<name>.log`
 * and outlive the instance. `--watch-interval` sets how often the review watcher
 * reads every watched PR (the server's PRKIT_WATCH_INTERVAL_MS; default 60 seconds).
 * `--dev-review-requested` makes auto mode treat a PR as a review request, since a
 * test can't ask real people to request reviews (the server's PRKIT_DEV_REVIEW_REQUESTED).
 * The server keeps a 60-second floor on the watch interval unless `--e2e` is given,
 * which only e2e.config.ts passes. `--github-api <url> --gh-home <dir>` points the
 * instance at a fake GitHub from scripts/fake-github.ts: its HOME holds the fake's gh
 * config and gh binary, so the real accounts and tokens on this machine are never read.
 * `--claude <file>` runs that file as Claude Code (the server's PRKIT_CLAUDE_PATH), such as
 * the stand-in `tests/fakeClaude.ts` sets up, so a guide spends no subscription.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

import { childEnv, ServerReadyLineJson } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  instancePaths,
  isAlive,
  isOurProcess,
  isValidName,
  listRuns,
  liveProcesses,
  readRun,
  repoRoot,
  type RunFile,
  SERVER_COMMAND,
  serverVersion,
  serverBuildId,
  SUPERVISOR_COMMAND,
  writeRun,
} from "./verify-run.ts";

const serverBin = NodePath.join(repoRoot, SERVER_COMMAND);
const webDist = NodePath.join(repoRoot, "apps/web/dist");
const decodeReadyLine = Schema.decodeUnknownOption(ServerReadyLineJson);
const Health = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    version: Schema.String,
    buildId: Schema.String,
    home: Schema.String,
  }),
);
const decodeHealth = Schema.decodeUnknownOption(Health);

const STOP_GRACE_MS = 8_000;
const DETACH_READY_MS = 30_000;

const say = (message: string) => process.stdout.write(`[verify-app] ${message}\n`);

const fail = (message: string): never => {
  process.stderr.write(`[verify-app] ${message}\n`);
  process.exit(1);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const logTail = (log: string, lines = 20): string =>
  NodeFS.existsSync(log)
    ? NodeFS.readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
    : "(no log)";

const fetchText = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

/** Refuses to start without a build, or while any process of a same-named instance lives. */
const preflight = (name: string) => {
  for (const required of [
    serverBin,
    NodePath.join(repoRoot, "apps/server/dist/build.json"),
    NodePath.join(webDist, "index.html"),
  ]) {
    if (!NodeFS.existsSync(required)) {
      fail(`missing ${NodePath.relative(repoRoot, required)}; run \`pnpm build\` first`);
    }
  }
  const existing = readRun(name);
  const live = Option.match(existing, { onNone: () => [], onSome: liveProcesses });
  if (Option.isSome(existing) && live.length > 0) {
    fail(
      `${name} is still running (pids ${live.join(", ")}) at ${existing.value.openUrl}; ` +
        `run \`stop --name ${name}\` or pick another --name`,
    );
  }
};

interface StartOptions {
  readonly name: string;
  readonly port: number;
  readonly rm: boolean;
  readonly watchInterval: number | null;
  readonly devWebOrigin: string | undefined;
  readonly devReviewRequested: string | undefined;
  readonly e2e: boolean;
  readonly githubApi: string | undefined;
  readonly ghHome: string | undefined;
  readonly claude: string | undefined;
}

const start = async (options: StartOptions) => {
  preflight(options.name);
  const paths = instancePaths(options.name);
  if (options.rm) NodeFS.rmSync(paths.home, { recursive: true, force: true });
  NodeFS.mkdirSync(paths.home, { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(paths.log), { recursive: true });

  const port = options.port === 0 ? await freePort() : options.port;
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const logFd = NodeFS.openSync(paths.log, "a");
  const note = (message: string) => {
    say(message);
    NodeFS.writeSync(logFd, `[verify-app] ${new Date().toISOString()} ${message}\n`);
  };
  note(`starting ${options.name} on port ${port}, home ${paths.home}`);

  // childEnv drops the caller's PRKIT_*, GH_TOKEN and GITHUB_TOKEN: the server reads
  // GitHub through the gh config dirs, never through a token in the environment. Each
  // agent's config folder carries over, so e2e and verify runs use the caller's own setup:
  // real-agent journeys spend whichever Claude account the caller's shell points at, and
  // find its sessions there. Stand-in agents never write to it.
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      serverBin,
      "--port",
      String(port),
      "--web-dist",
      webDist,
      "--log-level",
      "debug",
      ...(options.devWebOrigin === undefined ? [] : ["--dev-web-origin", options.devWebOrigin]),
    ],
    {
      cwd: repoRoot,
      env: {
        ...childEnv(process.env, {
          CODEX_HOME: process.env.CODEX_HOME,
          CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        }),
        PRKIT_HOME: paths.home,
        PRKIT_AUTH_TOKEN: token,
        ...(options.watchInterval === null
          ? {}
          : { PRKIT_WATCH_INTERVAL_MS: String(options.watchInterval) }),
        ...(options.devReviewRequested === undefined
          ? {}
          : { PRKIT_DEV_REVIEW_REQUESTED: options.devReviewRequested }),
        ...(options.e2e ? { PRKIT_E2E: "1" } : {}),
        ...(options.githubApi === undefined || options.ghHome === undefined
          ? {}
          : {
              HOME: options.ghHome,
              PRKIT_GH_PATH: NodePath.join(options.ghHome, "gh"),
              PRKIT_GITHUB_API_URL: options.githubApi,
            }),
        ...(options.claude === undefined ? {} : { PRKIT_CLAUDE_PATH: options.claude }),
      },
      stdio: ["ignore", "pipe", logFd],
    },
  );
  const serverPid = server.pid;
  if (serverPid === undefined) {
    await new Promise((resolve) => server.once("error", resolve));
    return fail(`could not start ${serverBin}`);
  }
  const url = `http://127.0.0.1:${port}`;
  const run: RunFile = {
    name: options.name,
    pid: process.pid,
    serverPid,
    port,
    url,
    openUrl: `${url}/?token=${token}`,
    token,
    home: paths.home,
    log: paths.log,
  };
  writeRun(run);

  let ready = false;
  let stopping = false;
  if (server.stdout) {
    NodeReadline.createInterface({ input: server.stdout }).on("line", (line) => {
      Option.match(decodeReadyLine(line), {
        onNone: () => NodeFS.writeSync(logFd, `${line}\n`),
        onSome: (readyLine) => {
          ready = true;
          if (readyLine.port !== port) note(`server reported port ${readyLine.port}`);
          note(`ready: ${run.openUrl}`);
        },
      });
    });
  }

  server.once("exit", (code, signal) => {
    const runFile = readRun(options.name);
    if (Option.isSome(runFile) && runFile.value.pid === process.pid) {
      NodeFS.rmSync(paths.runFile, { force: true });
    }
    if (options.rm) NodeFS.rmSync(paths.home, { recursive: true, force: true });
    note(`server exited (${signal ?? code})${options.rm ? "; home removed" : ""}`);
    if (!ready) process.stderr.write(`${logTail(paths.log)}\n`);
    process.exit(stopping ? 0 : 1);
  });

  const stopServer = () => {
    if (stopping) return;
    stopping = true;
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), STOP_GRACE_MS).unref();
  };
  process.on("SIGINT", stopServer);
  process.on("SIGTERM", stopServer);
  process.on("SIGHUP", stopServer);
};

/** Starts `start` as its own session and returns once the instance answers /health. */
const startDetached = async (options: StartOptions) => {
  preflight(options.name);
  const args = [
    NodePath.join(repoRoot, SUPERVISOR_COMMAND),
    "start",
    "--name",
    options.name,
    "--port",
    String(options.port),
    ...(options.rm ? ["--rm"] : []),
    ...(options.watchInterval === null ? [] : ["--watch-interval", String(options.watchInterval)]),
    ...(options.devWebOrigin === undefined ? [] : ["--dev-web-origin", options.devWebOrigin]),
    ...(options.devReviewRequested === undefined
      ? []
      : ["--dev-review-requested", options.devReviewRequested]),
    ...(options.e2e ? ["--e2e"] : []),
    ...(options.githubApi === undefined ? [] : ["--github-api", options.githubApi]),
    ...(options.ghHome === undefined ? [] : ["--gh-home", options.ghHome]),
    ...(options.claude === undefined ? [] : ["--claude", options.claude]),
  ];
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const running = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + DETACH_READY_MS;
  while (Date.now() < deadline && running()) {
    const run = readRun(options.name).pipe(Option.filter((found) => found.pid === child.pid));
    if (Option.isSome(run) && (await fetchText(`${run.value.url}/health`)).status === 200) {
      say(`ready: ${run.value.openUrl}`);
      say(`run file: ${NodePath.relative(repoRoot, instancePaths(options.name).runFile)}`);
      say(`supervisor pid ${run.value.pid}, server pid ${run.value.serverPid}`);
      say(`log: ${NodePath.relative(repoRoot, run.value.log)}`);
      return;
    }
    await sleep(200);
  }
  if (running() && child.pid !== undefined) process.kill(child.pid, "SIGTERM");
  fail(
    `${options.name} did not answer within ${DETACH_READY_MS}ms\n${logTail(instancePaths(options.name).log)}`,
  );
};

const checkRun = async (run: RunFile): Promise<boolean> => {
  const health = await fetchText(`${run.url}/health`);
  const decoded = decodeHealth(health.body);
  const reported = (field: "version" | "buildId" | "home") =>
    Option.match(decoded, { onNone: () => "?", onSome: (body) => body[field] });
  const page = await fetchText(`${run.url}/`);
  const expectedVersion = serverVersion();
  const expectedBuild = serverBuildId();
  const checks: Array<[boolean, string]> = [
    [isOurProcess(run.pid, SUPERVISOR_COMMAND), `supervisor pid ${run.pid} alive`],
    [isOurProcess(run.serverPid, SERVER_COMMAND), `server pid ${run.serverPid} alive`],
    [
      health.status === 200 && Option.exists(decoded, (body) => body.ok),
      `GET ${run.url}/health -> ${health.status}`,
    ],
    [
      reported("version") === expectedVersion,
      `version ${reported("version")} (expected ${expectedVersion})`,
    ],
    [reported("home") === run.home, `home ${reported("home")} (expected ${run.home})`],
    [
      reported("buildId") === expectedBuild,
      `build ${reported("buildId")} (expected ${expectedBuild})`,
    ],
    [
      page.status === 200 && page.body.includes('<div id="root">'),
      `GET ${run.url}/ serves the built UI`,
    ],
  ];
  say(`${run.name}:`);
  for (const [ok, label] of checks) say(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  say(`  open ${run.openUrl}`);
  say(`  log  ${NodePath.relative(repoRoot, run.log)}`);
  return checks.every(([ok]) => ok);
};

const doctor = async (name: string | undefined) => {
  const runs = name === undefined ? listRuns() : Option.toArray(readRun(name));
  if (runs.length === 0) {
    fail(name === undefined ? "no instances in .e2e/run/" : `no run file for ${name}`);
  }
  let healthy = true;
  for (const run of runs) healthy = (await checkRun(run)) && healthy;
  if (!healthy) process.exit(1);
};

const stop = async (options: { name: string; keepHome: boolean }) => {
  const paths = instancePaths(options.name);
  const run = readRun(options.name);
  if (Option.isSome(run)) {
    const live = liveProcesses(run.value);
    // The supervisor stops its own server; a server whose supervisor was killed gets the signal itself.
    if (live[0] !== undefined) process.kill(live[0], "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS + 2_000;
    while (Date.now() < deadline && live.some(isAlive)) await sleep(100);
    for (const pid of liveProcesses(run.value)) process.kill(pid, "SIGKILL");
    NodeFS.rmSync(paths.runFile, { force: true });
    say(`${options.name}: stopped pids ${live.join(", ") || "(none alive)"}`);
  } else {
    say(`${options.name}: no run file, nothing running`);
  }
  if (!options.keepHome) {
    NodeFS.rmSync(paths.home, { recursive: true, force: true });
    say(`${options.name}: removed ${NodePath.relative(repoRoot, paths.home)}`);
  }
  say(`${options.name}: kept ${NodePath.relative(repoRoot, paths.log)} and .e2e/evidence/`);
};

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    port: { type: "string", default: "0" },
    rm: { type: "boolean", default: false },
    detach: { type: "boolean", default: false },
    "keep-home": { type: "boolean", default: false },
    "watch-interval": { type: "string" },
    "dev-web-origin": { type: "string" },
    "dev-review-requested": { type: "string" },
    e2e: { type: "boolean", default: false },
    "github-api": { type: "string" },
    "gh-home": { type: "string" },
    claude: { type: "string" },
  },
});
const command = positionals[0];
const name = values.name ?? "verify";
const port = Number(values.port);
if (!isValidName(name)) fail(`--name must match [a-z0-9-], got ${name}`);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be 0-65535`);
const watchInterval =
  values["watch-interval"] === undefined ? null : Number(values["watch-interval"]);
if (watchInterval !== null && (!Number.isInteger(watchInterval) || watchInterval < 1000))
  fail(`--watch-interval must be a whole number of milliseconds, at least 1000`);
if ((values["github-api"] === undefined) !== (values["gh-home"] === undefined))
  fail("--github-api and --gh-home go together");

switch (command) {
  case "start":
    await (values.detach ? startDetached : start)({
      name,
      port,
      rm: values.rm,
      watchInterval,
      devWebOrigin: values["dev-web-origin"],
      devReviewRequested: values["dev-review-requested"],
      e2e: values.e2e,
      githubApi: values["github-api"],
      ghHome: values["gh-home"] === undefined ? undefined : NodePath.resolve(values["gh-home"]),
      claude: values.claude === undefined ? undefined : NodePath.resolve(values.claude),
    });
    break;
  case "doctor":
    await doctor(values.name);
    break;
  case "stop":
    await stop({ name, keepHome: values["keep-home"] });
    break;
  default:
    fail("usage: node scripts/verify-app.ts <start|doctor|stop> [--name <name>]");
}
