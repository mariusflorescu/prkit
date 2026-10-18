import * as NodeOS from "node:os";

import {
  type AgentModel,
  type AgentProviderState,
  childEnv,
  type ModelOptionChoice,
  type ModelOptionDescriptor,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { agentBinary } from "../../executables.ts";
import {
  AgentError,
  type AgentEvent,
  type AgentProvider,
  type ForkTurnInput,
  type InstanceSetup,
  QUIET_TOOLS,
  startOf,
  TOOL_LABELS,
  type TurnInput,
  type TurnSetup,
  type TurnStart,
} from "../AgentProvider.ts";
import { checkoutPaths } from "../checkoutPaths.ts";
import { describeCommand } from "../commandReads.ts";
import { TURN_MARKER, watchTurn } from "../turnEnd.ts";
import { type CodexApprovals, makeCodexApprovals } from "./approvals.ts";
import * as JsonRpcClient from "./JsonRpcClient.ts";
import {
  accountState,
  type CodexHomeLogin,
  homeLogin,
  keychainLogin,
  layOutHome,
  SIGN_IN,
  signInForPrkit,
  SIGN_OUT,
  storeOverride,
  unavailable,
} from "./login.ts";
import * as Protocol from "./protocol.ts";
import { codexSandbox, PROFILE } from "./sandbox.ts";

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim().slice(0, 100);

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
/**
 * "ultra" hands work to sub-agents, which prkit turns off (`features.multi_agent`),
 * so offering it would promise something the turn can't do.
 */
const DELEGATING_EFFORTS = new Set(["ultra"]);

const choice = (
  id: string,
  label: string,
  description: string | null | undefined,
  isDefault: boolean,
): ModelOptionChoice => ({
  id,
  label,
  ...(description == null || description === "" ? {} : { description }),
  ...(isDefault ? { isDefault: true } : {}),
});

/** A `model/list` entry as a catalog model: reasoning effort and service tier, as Codex reports them. */
const toModel = (model: Protocol.CodexModel): AgentModel => {
  const efforts = model.supportedReasoningEfforts.filter(
    (entry) => !DELEGATING_EFFORTS.has(entry.reasoningEffort),
  );
  const options: Array<ModelOptionDescriptor> = [];
  const [firstEffort, ...otherEfforts] = efforts.map((entry) =>
    choice(
      entry.reasoningEffort,
      EFFORT_LABELS[entry.reasoningEffort] ?? entry.reasoningEffort,
      entry.description,
      entry.reasoningEffort === model.defaultReasoningEffort,
    ),
  );
  if (firstEffort !== undefined)
    options.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [firstEffort, ...otherEfforts],
    });
  const tiers = model.serviceTiers ?? [];
  if (tiers.length > 0)
    options.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        choice(
          "default",
          "Standard",
          null,
          !tiers.some((tier) => tier.id === model.defaultServiceTier),
        ),
        ...tiers.map((tier) =>
          choice(tier.id, tier.name, tier.description, tier.id === model.defaultServiceTier),
        ),
      ],
    });
  return {
    slug: model.model,
    name: model.displayName.replace(/^gpt/i, "GPT"),
    description: model.description ?? null,
    isDefault: model.isDefault === true,
    options,
    blocked: null,
  };
};

/**
 * The request that opens a turn's thread. Each sends the turn's whole runtime, and each answer
 * gets the same check: a fork's carries the permission profile too (measured on Codex 0.163).
 */
const threadRequest = (start: TurnStart, runtime: Schema.JsonObject) => {
  switch (start._tag) {
    case "new":
      return { method: "thread/start", params: runtime };
    case "resume":
      return { method: "thread/resume", params: { ...runtime, threadId: start.id } };
    case "fork":
      // Without `excludeTurns` the answer would carry every turn of the source thread.
      return {
        method: "thread/fork",
        params: { ...runtime, threadId: start.from, excludeTurns: true },
      };
  }
};

/** How long a short `codex` command (login status, logout) may take before prkit gives up on it. */
export const CommandTimeout = Context.Reference<Duration.Input>(
  "@prkit/server/agents/codex/CodexAgent/CommandTimeout",
  { defaultValue: () => "15 seconds" },
);
/** `effect`, or `orElse` once it has taken longer than CommandTimeout. */
const shortCommand = <A, E, R>(effect: Effect.Effect<A, E, R>, orElse: A) =>
  Effect.gen(function* () {
    const duration = yield* CommandTimeout;
    return yield* Effect.timeoutOrElse(effect, { duration, orElse: () => Effect.succeed(orElse) });
  });

/**
 * One Codex instance. Codex gives every thread the AGENTS.md in its home, and no setting turns
 * that off, so each instance runs in a home of prkit's own, which shares the login file of the
 * instance's Codex home (CODEX_HOME, else ~/.codex) when there is one and keeps a keychain login
 * of its own otherwise (`homeLogin`), or always, for an instance signed in with ChatGPT for prkit.
 */
export const make = Effect.fn("CodexAgent.make")(function* (setup: InstanceSetup) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const server = yield* ServerConfig;
  const binary = agentBinary(setup.binaryPath, process.env.PRKIT_CODEX_PATH, "codex").pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  const notInstalled =
    setup.binaryPath === null
      ? "Codex isn't installed. Install Codex, run codex login with your ChatGPT account, then check again."
      : `There's no Codex at ${setup.binaryPath}. Fix the binary path in Settings > Agents, then check again.`;
  // The default keeps `$PRKIT_HOME/codex`: Codex names a keychain login after its home's path,
  // so moving it would lose prkit's login and the sessions guides and fixes resume.
  const home = path.resolve(
    setup.isDefault
      ? path.join(server.home, "codex")
      : path.join(server.home, "codex-instances", setup.id),
  );
  const ownOnly = setup.login === "prkit";
  const userAuthFile = path.join(
    path.resolve(setup.configDir ?? path.join(NodeOS.homedir(), ".codex")),
    "auth.json",
  );
  /** Whether a short `codex` command succeeded. Only the exit code is read: the output can name a key. */
  const succeeds = (codex: string, args: ReadonlyArray<string>, codexHome: string | undefined) =>
    shortCommand(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(codex, args, {
              env: childEnv(process.env, { ...setup.environment, CODEX_HOME: codexHome }),
              extendEnv: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          return (yield* child.exitCode) === 0;
        }),
      ),
      false,
    ).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
  /**
   * What `codex login status` says about `codexHome`. Only Codex's own "Not logged in" counts as
   * signed out: a timeout, a failed start or any other answer is unknown. The output is read for
   * that phrase alone and never logged.
   */
  const loginStatus = (codex: string, args: ReadonlyArray<string>, codexHome: string) => {
    /** Why the answer is unknown, for the log: never the output, which can name a key. */
    const unknown = (why: string) =>
      Effect.logWarning("Codex didn't confirm a login status").pipe(
        Effect.annotateLogs({ instance: setup.id, why }),
        Effect.as("unknown" as const),
      );
    return shortCommand(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(codex, [...args, "login", "status"], {
              env: childEnv(process.env, { ...setup.environment, CODEX_HOME: codexHome }),
              extendEnv: false,
              stdin: "ignore",
            }),
          );
          const [, errors, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code === 0) return "signed-in" as const;
          // Only Codex's own answer counts: a non-zero exit with exactly this on stderr.
          if (errors.trim() === "Not logged in") return "signed-out" as const;
          // Codex's own error line says what went wrong; any other output could name a key.
          const error = /^Error\b.{0,200}/m.exec(errors)?.[0];
          return yield* unknown(`exit ${code}${error === undefined ? "" : `: ${error}`}`);
        }),
      ),
      null,
    ).pipe(
      Effect.flatMap((status) => (status === null ? unknown("timed out") : Effect.succeed(status))),
      Effect.catchTag("PlatformError", (error) => unknown(`couldn't start: ${error.message}`)),
    );
  };
  const loginState = (
    response: typeof Protocol.AccountResponse.Type,
    login: CodexHomeLogin,
    executable: string,
  ) =>
    ownOnly && response.account === null
      ? Effect.succeed(signInForPrkit(home))
      : response.account !== null || login._tag === "shared" || ownOnly
        ? Effect.succeed(accountState(response, login))
        : succeeds(executable, ["login", "status"], setup.configDir ?? undefined).pipe(
            Effect.map((signedIn) =>
              signedIn ? keychainLogin(home) : accountState(response, login),
            ),
          );
  const preparing = yield* Semaphore.make(1);
  /** Lays out prkit's Codex home for the login it uses now. Safe to run again at any point. */
  const prepareHome = (codex: string) =>
    preparing
      .withPermits(1)(
        Effect.gen(function* () {
          const login: CodexHomeLogin = ownOnly
            ? { _tag: "own" }
            : homeLogin(userAuthFile, yield* fs.exists(userAuthFile));
          // Pinned to the keychain, this signs out only prkit's own entry. Codex then removes
          // the auth.json in prkit's home, a link at most, without reading through it.
          const retire = succeeds(
            codex,
            ["-c", storeOverride({ _tag: "own" }), "logout"],
            home,
          ).pipe(
            Effect.tap((done) =>
              done
                ? Effect.logInfo("Signed out prkit's own Codex login: it shares yours now")
                : Effect.logWarning(
                    "Couldn't sign out prkit's own Codex login; trying again later",
                  ),
            ),
          );
          yield* layOutHome(home, login, retire);
          return login;
        }),
      )
      .pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (error) =>
            new AgentError({
              reason: "auth",
              message: `prkit couldn't set up its own Codex folder ${home}: ${error.message}`,
            }),
        ),
      );
  const open = (
    cwd?: string,
    extras: Readonly<Record<string, string>> = {},
    approvals: CodexApprovals | null = null,
  ) =>
    Effect.gen(function* () {
      const codex = yield* binary;
      if (codex === null) return yield* new AgentError({ reason: "auth", message: notInstalled });
      const login = yield* prepareHome(codex);
      const client = yield* JsonRpcClient.make({
        executable: codex,
        ...(cwd === undefined ? {} : { cwd }),
        env: childEnv(process.env, { ...setup.environment, ...extras, CODEX_HOME: home }),
        config: [storeOverride(login)],
        ...(approvals === null ? {} : { approvals }),
      });
      return { client, login, codex };
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const check = Effect.scoped(
    Effect.gen(function* () {
      const { client, login, codex } = yield* open();
      return yield* loginState(
        yield* client.request("account/read", { refreshToken: false }, Protocol.AccountResponse),
        login,
        codex,
      );
    }),
  ).pipe(
    Effect.catchTag("AgentError", (error) =>
      Effect.succeed(
        unavailable(error.message === notInstalled ? "not-installed" : "error", error.message),
      ),
    ),
  );

  const version = Effect.scoped(
    Effect.gen(function* () {
      const codex = yield* binary;
      if (codex === null) return null;
      const child = yield* spawner.spawn(
        ChildProcess.make(codex, ["--version"], {
          env: childEnv(process.env, { CODEX_HOME: home }),
          extendEnv: false,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const text = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      return /\d+\.\d+[^\s]*/.exec(text)?.[0] ?? null;
    }),
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => null),
  );

  /**
   * Before the instance is removed: signs out the keychain login prkit may hold in its home,
   * pinned to the keychain so a shared login file is never touched, then deletes the home.
   * The home goes only once Codex itself says that login is signed out. Without Codex, or
   * without that answer, the removal is refused and the home kept, so the login is never left
   * with nothing to remove it.
   */
  const retire = preparing
    .withPermits(1)(
      Effect.gen(function* () {
        if (setup.isDefault) return;
        // Only a home holding its own login has a config.toml; a shared one holds a link.
        if (yield* fs.exists(path.join(home, "config.toml"))) {
          const codex = yield* binary;
          if (codex === null)
            return yield* new AgentError({
              reason: "auth",
              message: `prkit needs Codex to sign out ${setup.label}'s ChatGPT login before removing it, and can't find it. Install Codex or fix the binary path, then remove it again.`,
            });
          const pinned = ["-c", storeOverride({ _tag: "own" })];
          yield* succeeds(codex, [...pinned, "logout"], home);
          const status = yield* loginStatus(codex, pinned, home);
          if (status !== "signed-out")
            return yield* new AgentError({
              reason: "auth",
              message:
                status === "signed-in"
                  ? `prkit couldn't sign out ${setup.label}'s ChatGPT login, so it kept the agent. Try again.`
                  : `prkit couldn't confirm ${setup.label}'s ChatGPT login is signed out, so it kept the agent. Try again.`,
            });
        }
        yield* fs.remove(home, { recursive: true, force: true });
        yield* Effect.logInfo("Removed a Codex instance's home").pipe(
          Effect.annotateLogs({ instance: setup.id }),
        );
      }),
    )
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new AgentError({
            reason: "agent",
            message: `prkit couldn't delete ${setup.label}'s folder: ${error.message}`,
          }),
        ),
      ),
    );

  /** Codex in prkit's home while that home keeps its own login; refused while it shares the user's. */
  const openOwn = Effect.gen(function* () {
    const { client, login } = yield* open();
    if (login._tag === "shared")
      return yield* new AgentError({
        reason: "auth",
        message: "Codex shares your own login with prkit, so there is no prkit login. Check again.",
      });
    return client;
  });
  const signIn = Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* openOwn;
      const started = yield* client.request(
        "account/login/start",
        { type: "chatgpt" },
        Protocol.LoginStartResponse,
        SIGN_IN,
      );
      yield* Effect.logInfo("Codex sign-in for prkit started");
      const finished = client.notifications.pipe(
        Stream.flatMap((notification) => {
          const done =
            notification.method === "account/login/completed"
              ? Schema.decodeUnknownOption(Protocol.LoginCompleted)(notification.params)
              : Option.none();
          return Option.isSome(done) && done.value.loginId === started.loginId
            ? Stream.make(done.value)
            : Stream.empty;
        }),
        Stream.runHead,
        // Codex exiting ends its notifications with the connection's error, worded for a guide.
        Effect.catchTag("AgentError", () => Effect.succeedNone),
        Effect.flatMap((done) =>
          Option.isSome(done) && done.value.success
            ? Effect.logInfo("Codex signed in for prkit")
            : Effect.fail(
                new AgentError({
                  reason: "auth",
                  message: Option.isSome(done)
                    ? `Signing in to Codex didn't finish (${done.value.error ?? "no reason given"}). Try again.`
                    : "Codex stopped before the sign-in finished. Try again.",
                }),
              ),
        ),
      );
      return Stream.make({ url: started.authUrl }).pipe(
        Stream.concat(Stream.fromEffect(finished).pipe(Stream.drain)),
      );
    }),
  );
  const signOut = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* openOwn;
      yield* client.request("account/logout", null, Schema.Json, SIGN_OUT);
      yield* Effect.logInfo("Codex signed out for prkit");
    }),
  );

  /** The signed-in account's models, as Codex lists them. Empty when Codex can't run. */
  const models = (state: AgentProviderState) =>
    state._tag === "unavailable"
      ? Effect.succeed([])
      : Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* open();
            const found: Array<AgentModel> = [];
            let cursor: string | null = null;
            do {
              const page: typeof Protocol.ModelListResponse.Type = yield* client.request(
                "model/list",
                cursor === null ? {} : { cursor },
                Protocol.ModelListResponse,
              );
              found.push(...page.data.filter((model) => model.hidden !== true).map(toModel));
              cursor = page.nextCursor ?? null;
            } while (cursor !== null);
            return found;
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Codex didn't list its models").pipe(
              Effect.annotateLogs({ message: error.message }),
            ),
          ),
          Effect.orElseSucceed((): ReadonlyArray<AgentModel> => []),
        );

  // Codex keeps threads in its home, not per folder, and the folder a thread was made in may be
  // gone (a done review's worktree), so the lookup doesn't run there.
  const hasSession = (sessionId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* open();
        const result = yield* client.request(
          "thread/read",
          { threadId: sessionId, includeTurns: false },
          Protocol.ThreadResponse,
        );
        return result.thread.id === sessionId;
      }),
    ).pipe(Effect.catchTag("AgentError", () => Effect.succeed(false)));

  const turn = (input: TurnSetup, start: TurnStart): Stream.Stream<AgentEvent, AgentError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // A guide, and a fix whose pull request's scripts don't run: Codex asks before every
        // command and edit, and prkit answers with the turn's rule (docs/internals/architecture.md
        // "Agents"). A fix whose scripts run asks nothing; its sandbox profile is the boundary.
        const approvals =
          input.access._tag === "read-only" || input.access.scripts._tag === "blocked"
            ? makeCodexApprovals(
                yield* checkoutPaths(fs, path, {
                  checkout: input.cwd,
                  readable: input.readableDirs,
                }),
                input.access,
              )
            : null;
        const approvalPolicy = approvals === null ? "never" : "untrusted";
        // Before Codex starts, so its end runs once Codex and its group are gone.
        const watch = yield* watchTurn(input.turn).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const env = { ...input.env, [TURN_MARKER]: input.turn.id };
        const { client, login, codex: executable } = yield* open(input.cwd, env, approvals);
        watch.follow(client.pid);
        const state = yield* loginState(
          yield* client.request("account/read", { refreshToken: false }, Protocol.AccountResponse),
          login,
          executable,
        );
        if (state._tag === "unavailable")
          return yield* new AgentError({ reason: "auth", message: state.message });
        const effective = yield* client.request(
          "config/read",
          { cwd: input.cwd, includeLayers: false },
          Protocol.ConfigResponse,
        );
        const mcpServers: Record<string, Schema.Json> = {};
        for (const name of Object.keys(effective.config.mcp_servers ?? {}))
          mcpServers[name] = { enabled: false };
        mcpServers.prkit = {
          enabled: true,
          url: input.mcp.url,
          http_headers: { Authorization: `Bearer ${input.mcp.bearerToken}` },
          enabled_tools: [...input.tools],
          required: true,
        };
        const writes = input.access._tag === "write";
        // A fix's commands keep their temporary files in the turn's own folder, not shared /tmp.
        const tmp = input.access._tag === "write" ? { TMPDIR: input.access.tmpDir } : {};
        const sandbox = yield* codexSandbox(fs, path, input, executable);
        yield* Effect.logInfo("Codex sandbox").pipe(
          Effect.annotateLogs({
            approvalPolicy,
            filesystem: sandbox.profile.filesystem,
            path: sandbox.path,
          }),
        );
        const config = {
          mcp_servers: mcpServers,
          forced_login_method: "chatgpt",
          web_search: "disabled",
          "features.multi_agent": false,
          "features.hooks": false,
          "features.code_mode": false,
          "features.apps": false,
          "tools.update_plan.enabled": false,
          project_doc_max_bytes: 0,
          // The skills list would name the user's own skills and the pull request's.
          "skills.include_instructions": false,
          [`permissions.${PROFILE}`]: sandbox.profile,
          default_permissions: PROFILE,
          shell_environment_policy: {
            inherit: "none",
            set: childEnv(process.env, { ...env, ...tmp, PATH: sandbox.path }),
          },
        };
        const runtime = {
          cwd: input.cwd,
          approvalPolicy,
          modelProvider: "openai",
          developerInstructions: input.instructions,
          config,
        };
        const opening = threadRequest(start, runtime);
        const response = yield* client.request(
          opening.method,
          opening.params,
          Protocol.ThreadRuntimeResponse,
        );
        if (
          response.modelProvider !== "openai" ||
          response.approvalPolicy !== approvalPolicy ||
          response.sandbox.networkAccess === true ||
          response.activePermissionProfile?.id !== PROFILE ||
          response.instructionSources.length > 0
        )
          return yield* new AgentError({
            reason: "auth",
            message:
              "Codex didn't apply prkit's subscription, sandbox and instruction settings. Update Codex and retry.",
          });
        const threadId = response.thread.id;
        yield* Effect.logInfo("Codex thread opened").pipe(
          Effect.annotateLogs({ threadId, start: start._tag }),
        );
        yield* Effect.gen(function* () {
          for (;;) {
            const status = yield* client.request(
              "mcpServerStatus/list",
              { threadId, serverName: "prkit" },
              Protocol.McpStatusResponse,
            );
            const server = status.data.find((entry) => entry.name === "prkit");
            const listed = new Set(Object.values(server?.tools ?? {}).map((tool) => tool.name));
            if (
              server?.runtimeStatus === "connected" &&
              input.tools.every((tool) => listed.has(tool))
            )
              return;
            if (
              (server?.toolsError !== null && server?.toolsError !== undefined) ||
              server?.runtimeStatus === "failed" ||
              server?.runtimeStatus === "authenticationRequired"
            )
              return yield* new AgentError({
                reason: "agent",
                message:
                  "Codex couldn't connect to prkit's tools. Retry; if it keeps failing, restart prkit.",
              });
            yield* Effect.sleep("200 millis");
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () =>
              Effect.fail(
                new AgentError({
                  reason: "agent",
                  message: "Codex couldn't connect to prkit's tools in time. Retry the guide.",
                }),
              ),
          }),
        );
        const option = (id: string) => {
          const value = input.options.find((entry) => entry.id === id)?.value;
          return typeof value === "string" ? value : undefined;
        };
        const effort = option("reasoningEffort");
        const serviceTier = option("serviceTier");
        const turn = yield* client.request(
          "turn/start",
          {
            threadId,
            cwd: input.cwd,
            approvalPolicy,
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
            // Sent every turn: a resumed thread otherwise keeps the last turn's choices.
            ...(input.model === null ? {} : { model: input.model }),
            ...(effort === undefined ? {} : { effort }),
            ...(serviceTier === undefined ? {} : { serviceTier }),
          },
          Protocol.TurnResponse,
        );
        const roots = [input.cwd, ...input.readableDirs];
        const relative = (target: string) => {
          for (const root of roots)
            if (target.startsWith(`${root}${path.sep}`)) return target.slice(root.length + 1);
          return target;
        };
        // Codex runs every command through a login shell, so its parsed actions say what
        // was read or searched and the raw command line does not.
        const actionLabel = (action: Protocol.CommandAction) => {
          if (Schema.is(Protocol.ReadAction)(action)) return `Read ${relative(action.path)}`;
          if (Schema.is(Protocol.ListFilesAction)(action))
            return action.path == null
              ? "Listed files"
              : `Listed files in ${relative(action.path)}`;
          if (Schema.is(Protocol.SearchAction)(action) && action.query != null)
            return `Searched for ${oneLine(action.query)}${action.path == null ? "" : ` in ${relative(action.path)}`}`;
          return describeCommand(action.command, relative)?.label ?? "Ran a command";
        };
        const events = (
          notification: JsonRpcClient.Notification,
        ): ReadonlyArray<AgentEvent> | AgentError => {
          switch (notification.method) {
            case "item/agentMessage/delta": {
              const delta = Schema.decodeUnknownOption(Protocol.MessageDelta)(notification.params);
              return Option.isSome(delta) && delta.value.threadId === threadId
                ? [{ _tag: "text", delta: delta.value.delta }]
                : [];
            }
            case "item/started": {
              const parsed = Schema.decodeUnknownOption(Protocol.ItemStarted)(notification.params);
              if (Option.isNone(parsed) || parsed.value.threadId !== threadId) return [];
              const item = parsed.value.item;
              if (item.type === "fileChange") {
                const paths = item.changes.map((change) => relative(change.path));
                return [
                  {
                    _tag: "tool",
                    id: item.id,
                    label: `Edited ${paths.length <= 2 ? paths.join(", ") : `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more`}`,
                    detail: null,
                    reads: [],
                  },
                ];
              }
              if (item.type === "commandExecution") {
                const actions = item.commandActions ?? [];
                const parsed = describeCommand(item.command, relative);
                const label =
                  actions.length === 0
                    ? (parsed?.label ?? (writes ? `Ran ${oneLine(item.command)}` : "Ran a command"))
                    : actions.map(actionLabel).join(", ");
                const reads =
                  parsed?.reads ??
                  actions.flatMap((action) =>
                    Schema.is(Protocol.ReadAction)(action)
                      ? [{ path: action.path, lines: { _tag: "all" } as const }]
                      : [],
                  );
                return [{ _tag: "tool", id: item.id, label, detail: oneLine(item.command), reads }];
              }
              if (item.server === "prkit" && QUIET_TOOLS.has(item.tool)) return [];
              const prkitLabel = item.server === "prkit" ? TOOL_LABELS[item.tool] : undefined;
              return prkitLabel !== undefined
                ? [
                    ...(item.tool === "submit_guide" ? [{ _tag: "composing-guide" } as const] : []),
                    {
                      _tag: "tool",
                      id: item.id,
                      label: prkitLabel,
                      detail: null,
                      reads: [],
                    },
                  ]
                : [
                    {
                      _tag: "tool",
                      id: item.id,
                      label: `Used ${item.tool}`,
                      detail: null,
                      reads: [],
                    },
                  ];
            }
            case "item/completed": {
              const parsed = Schema.decodeUnknownOption(Protocol.ItemCompleted)(
                notification.params,
              );
              if (Option.isNone(parsed) || parsed.value.threadId !== threadId) return [];
              const item = parsed.value.item;
              return [
                {
                  _tag: "tool-done",
                  id: item.id,
                  ok: item.status === "completed" && (item.exitCode == null || item.exitCode === 0),
                },
              ];
            }
            case "turn/completed": {
              const parsed = Schema.decodeUnknownOption(Protocol.TurnCompleted)(
                notification.params,
              );
              if (Option.isNone(parsed))
                return new AgentError({
                  reason: "agent",
                  message: "Codex returned an invalid turn outcome. Update Codex and retry.",
                });
              if (parsed.value.threadId !== threadId || parsed.value.turn.id !== turn.turn.id)
                return [];
              const result = parsed.value.turn;
              if (result.status === "inProgress")
                return new AgentError({
                  reason: "agent",
                  message: "Codex ended a turn without a final outcome. Retry the guide.",
                });
              return [
                {
                  _tag: "finished",
                  outcome: result.status,
                  message: result.error?.message ?? null,
                },
              ];
            }
            default:
              return [];
          }
        };
        return Stream.fromIterable<AgentEvent>([
          { _tag: "process", pid: client.pid },
          { _tag: "session", sessionId: threadId },
          { _tag: "mcp-ready" },
        ]).pipe(
          Stream.concat(
            client.notifications.pipe(
              Stream.flatMap((message) => {
                const mapped = events(message);
                return Schema.is(AgentError)(mapped)
                  ? Stream.fail(mapped)
                  : Stream.fromIterable(mapped);
              }),
              Stream.takeUntil((event) => event._tag === "finished"),
            ),
          ),
        );
      }),
    );
  return {
    instance: setup.id,
    kind: "codex",
    label: setup.label,
    // Codex keeps its threads in the home it runs in, which is prkit's own for each instance.
    group: `codex:${home}`,
    version,
    retire,
    // app-server reports a tool call only once it is complete, so Codex drafts with submit_draft.
    streamsGuideInput: false,
    check,
    models,
    hasSession,
    runTurn: (input: TurnInput) => turn(input, startOf(input)),
    forkTurn: (input: ForkTurnInput) => turn(input, { _tag: "fork", from: input.forkFrom }),
    ownLogin: { signIn, signOut },
  } satisfies AgentProvider;
});
