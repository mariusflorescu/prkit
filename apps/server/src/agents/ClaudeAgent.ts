// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK's spawn hook must return a node ChildProcess.
import * as NodeChildProcess from "node:child_process";

import {
  type CanUseTool,
  getSessionInfo,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type AgentProviderState, childEnv } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import { executableAt, findOnPath } from "../executables.ts";
import {
  AgentError,
  type AgentEvent,
  type AgentProvider,
  QUIET_TOOLS,
  TOOL_LABELS,
  type TurnInput,
} from "./AgentProvider.ts";
import {
  claudePermissions,
  decodeBashInput,
  decodePathInput,
  MCP_PREFIX,
  MCP_SERVER_NAME,
} from "./claudePermissions.ts";
import { checkoutPaths, spellingsOf } from "./checkoutPaths.ts";
import { claudeTurnSandbox } from "./claudeSandbox.ts";
import { claudeModels, compileClaudeSelection } from "./claudeModels.ts";
import { describeCommand, type FileRead } from "./commandReads.ts";
import { TURN_MARKER, watchTurn } from "./turnEnd.ts";

export const SUBMIT_GUIDE_TOOL = `${MCP_PREFIX}submit_guide`;
/** Claude's guide streams as it writes `submit_guide`, so it never needs to draft first. */
const SUBMIT_DRAFT_TOOL = `${MCP_PREFIX}submit_draft`;
/** Claude Code's Read tool shows this many lines when the call sets no limit. */
const READ_DEFAULT_LIMIT = 2000;
/**
 * The SDK passes `mcpServers` on the CLI's command line, which every local user can
 * read. The bearer token travels in the child's environment instead, and the CLI
 * expands this reference when it connects.
 */
const MCP_AUTH_ENV = "PRKIT_MCP_AUTHORIZATION";

const AuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.optionalKey(Schema.String),
  apiProvider: Schema.optionalKey(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeAuthStatus = Schema.decodeUnknownOption(Schema.fromJsonString(AuthStatus));

const NOT_INSTALLED =
  "Claude Code isn't installed. Install it from claude.com/claude-code, sign in, then check again.";
const LOGIN = "claude auth login";

const unavailable = (
  reason: Extract<AgentProviderState, { _tag: "unavailable" }>["reason"],
  message: string,
  fix: string | null = null,
): AgentProviderState => ({ _tag: "unavailable", reason, message, fix, ownLogin: false });

const oneLine = (text: string, max = 80) => {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const services = yield* Effect.context<never>();
  const override = process.env.PRKIT_CLAUDE_PATH;
  const claudePath =
    override === undefined ? yield* findOnPath("claude") : yield* executableAt(override);
  yield* claudePath === null
    ? Effect.logWarning("Claude Code not found")
    : Effect.logInfo("Resolved Claude Code").pipe(Effect.annotateLogs({ path: claudePath }));

  /**
   * The allowlisted environment, plus CLAUDE_CONFIG_DIR when the user moved Claude's
   * config: that is where their login lives. Nothing that could switch billing
   * (ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, ...) is ever copied.
   */
  const agentEnv = (extras: Readonly<Record<string, string>> = {}) =>
    childEnv(process.env, {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_AGENT_SDK_CLIENT_APP: `prkit/${packageJson.version}`,
      // Tool input arrives as the model writes it instead of in buffered chunks, which
      // is what lets the guide show while submit_guide is still being written.
      CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
      ...extras,
    });

  const output = (executable: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            env: agentEnv(),
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        return yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      }),
    ).pipe(Effect.timeout("15 seconds"));

  /** `claude auth status --json` reads the stored login in about 0.2s without starting a model turn. */
  const check: Effect.Effect<AgentProviderState> = Effect.gen(function* () {
    if (claudePath === null) return unavailable("not-installed", NOT_INSTALLED);
    const status = decodeAuthStatus(yield* output(claudePath, ["auth", "status", "--json"]));
    if (Option.isNone(status))
      return unavailable(
        "error",
        "Claude Code gave an unexpected login status. Update Claude Code, then check again.",
      );
    if (!status.value.loggedIn)
      return unavailable(
        "logged-out",
        "Claude Code isn't signed in. Sign in with your Claude account, then check again.",
        LOGIN,
      );
    if (
      status.value.authMethod !== "claude.ai" ||
      (status.value.apiProvider ?? "firstParty") !== "firstParty"
    )
      return unavailable(
        "not-subscription",
        `Claude Code is signed in with ${status.value.authMethod ?? "an API key"}, not a Claude subscription. prkit only runs Claude on your subscription: sign in with your Claude account.`,
        LOGIN,
      );
    const plan = status.value.subscriptionType ?? "";
    return {
      _tag: "ready",
      detail:
        plan === ""
          ? "Claude subscription"
          : `Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)} subscription`,
      ownLogin: false,
    } satisfies AgentProviderState;
  }).pipe(
    Effect.catchTags({
      PlatformError: () => Effect.succeed(unavailable("not-installed", NOT_INSTALLED)),
      TimeoutError: () =>
        Effect.succeed(
          unavailable("error", "Claude Code took too long to report its login. Check again."),
        ),
    }),
  );

  /** The bundled models, checked against the installed Claude Code's version. */
  const models = () =>
    Effect.gen(function* () {
      if (claudePath === null) return claudeModels(null);
      const version = (yield* output(claudePath, ["--version"])).trim();
      return claudeModels(version === "" ? null : version);
    }).pipe(Effect.orElseSucceed(() => claudeModels(null)));

  const hasSession = (sessionId: string, cwd: string) =>
    Effect.tryPromise(() => getSessionInfo(sessionId, { dir: cwd })).pipe(
      Effect.map((info) => info !== undefined),
      Effect.orElseSucceed(() => false),
    );

  const runTurn = (input: TurnInput): Stream.Stream<AgentEvent, AgentError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (claudePath === null)
          return yield* new AgentError({ reason: "auth", message: NOT_INSTALLED });
        const log = (effect: Effect.Effect<void>) => {
          Effect.runForkWith(services)(effect);
        };
        const roots = yield* spellingsOf(fs, [input.cwd, ...input.readableDirs]);
        const permissions = claudePermissions(
          input,
          yield* checkoutPaths(fs, path, { checkout: input.cwd, readable: input.readableDirs }),
        );
        const decide = permissions.decide;
        const sandbox = yield* claudeTurnSandbox(fs, path, input);
        // Before Claude starts, so its end runs once Claude and its group are gone.
        const watch = yield* watchTurn(input.turn).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const relative = (target: string) => {
          for (const root of roots) {
            const resolved = path.resolve(input.cwd, target);
            if (resolved.startsWith(`${root}${path.sep}`)) return resolved.slice(root.length + 1);
          }
          return target;
        };

        const canUseTool: CanUseTool = async (toolName, toolInput) => {
          const result = await Effect.runPromiseWith(services)(decide(toolName, toolInput));
          const bash = toolName === "Bash" ? decodeBashInput(toolInput) : Option.none();
          const target = decodePathInput(toolInput).pipe(
            Option.flatMap((value) => Option.fromNullishOr(value.file_path ?? value.path)),
          );
          log(
            Effect.logInfo("canUseTool").pipe(
              Effect.annotateLogs({
                tool: toolName,
                decision: result.behavior,
                ...(Option.isSome(bash) ? { command: oneLine(bash.value.command, 200) } : {}),
                ...(Option.isSome(target) ? { path: target.value } : {}),
                ...(result.behavior === "deny" ? { reason: result.message } : {}),
              }),
            ),
          );
          return result;
        };

        let child: NodeChildProcess.ChildProcess | null = null;
        let stderrTail = "";
        const selection =
          input.model === null ? null : compileClaudeSelection(input.model, input.options);
        const options: Options = {
          ...(selection === null ? {} : { model: selection.model }),
          ...(selection?.effort === undefined ? {} : { effort: selection.effort }),
          cwd: input.cwd,
          additionalDirectories: [...input.readableDirs],
          pathToClaudeCodeExecutable: claudePath,
          env: agentEnv({
            ...input.env,
            ...sandbox.env,
            [TURN_MARKER]: input.turn.id,
            [MCP_AUTH_ENV]: `Bearer ${input.mcp.bearerToken}`,
          }),
          systemPrompt: { type: "preset", preset: "claude_code", append: input.instructions },
          tools: [...permissions.tools],
          // Claude streams submit_guide, so it never drafts; other turns' tools stay hidden too.
          disallowedTools: [...new Set([SUBMIT_DRAFT_TOOL, ...permissions.disallowedTools])],
          permissionMode: "default",
          canUseTool,
          // No user or project settings: a PR could ship .claude/settings.json with hooks or allow rules.
          settingSources: [],
          // Claude Code auto-approves commands it thinks are read-only; `ask` sends every one to canUseTool.
          settings: {
            permissions: { ask: [...permissions.ask] },
            ...(selection?.fastMode === undefined ? {} : { fastMode: selection.fastMode }),
          },
          // Every command runs inside a sandbox that holds it to the checkout, a fix's PR scripts too.
          sandbox: sandbox.sandbox,
          strictMcpConfig: true,
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "http",
              url: input.mcp.url,
              headers: { Authorization: `\${${MCP_AUTH_ENV}}` },
              // Loads prkit's tools up front and waits for the connection, so init reports its status.
              alwaysLoad: true,
            },
          },
          includePartialMessages: true,
          ...(input.resumeSessionId === null ? {} : { resume: input.resumeSessionId }),
          spawnClaudeCodeProcess: (spawn) => {
            // Its own process group, so stopping the turn also stops commands the agent started.
            const started = NodeChildProcess.spawn(spawn.command, spawn.args, {
              ...(spawn.cwd === undefined ? {} : { cwd: spawn.cwd }),
              env: spawn.env,
              stdio: ["pipe", "pipe", "pipe"],
              detached: true,
            });
            child = started;
            if (started.pid !== undefined) watch.follow(started.pid);
            started.stderr.on("data", (chunk: Buffer) => {
              stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
            });
            log(
              Effect.logInfo("Claude started").pipe(
                Effect.annotateLogs({ pid: started.pid ?? null, cwd: input.cwd }),
              ),
            );
            return started;
          },
        };

        const turn = query({ prompt: `${selection?.promptPrefix ?? ""}${input.prompt}`, options });
        const exited = (proc: NodeChildProcess.ChildProcess) =>
          proc.exitCode !== null || proc.signalCode !== null;
        const waitForExit = (proc: NodeChildProcess.ChildProcess, timeout: `${number} seconds`) =>
          Effect.callback<void>((resume) => {
            if (exited(proc)) return resume(Effect.void);
            const onExit = () => resume(Effect.void);
            proc.once("exit", onExit);
            return Effect.sync(() => proc.off("exit", onExit));
          }).pipe(Effect.timeoutOption(timeout), Effect.asVoid);
        const signalGroup = (pid: number, signal: NodeJS.Signals) =>
          Effect.sync(() => {
            try {
              process.kill(-pid, signal);
              return true;
            } catch {
              return false;
            }
          });

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => turn.close());
            const proc = child;
            if (proc === null || proc.pid === undefined) return;
            const pid = proc.pid;
            yield* waitForExit(proc, "3 seconds");
            if (!exited(proc)) {
              yield* signalGroup(pid, "SIGTERM");
              yield* waitForExit(proc, "3 seconds");
            }
            if (!exited(proc)) {
              yield* signalGroup(pid, "SIGKILL");
              yield* waitForExit(proc, "3 seconds");
            }
            // Commands the agent left behind share the group even after Claude itself exits.
            yield* signalGroup(pid, "SIGKILL");
            yield* Effect.logInfo("Claude exited").pipe(
              Effect.annotateLogs({ pid, code: proc.exitCode, signal: proc.signalCode }),
            );
          }),
        );

        /** The `submit_guide` calls being written, by their block's index in the message. */
        const guideCalls = new Map<number, string>();
        const toEvents = (
          message: SDKMessage,
        ): Effect.Effect<ReadonlyArray<AgentEvent>, AgentError> => {
          switch (message.type) {
            case "system": {
              if (message.subtype !== "init") return Effect.succeed([]);
              // "none" means the claude.ai login; anything else would bill an API key.
              if (message.apiKeySource !== "none")
                return Effect.fail(
                  new AgentError({
                    reason: "auth",
                    message: `Claude Code is set to use an API key (${message.apiKeySource}). prkit only runs Claude on your subscription, so it stopped before doing any work.`,
                  }),
                );
              const server = message.mcp_servers.find((entry) => entry.name === MCP_SERVER_NAME);
              if (server?.status !== "connected")
                return Effect.fail(
                  new AgentError({
                    reason: "agent",
                    message: `Claude couldn't connect to prkit's tools (status: ${server?.status ?? "missing"}). Retry; if it keeps failing, restart prkit.`,
                  }),
                );
              const pid = child?.pid;
              return Effect.succeed([
                ...(pid === undefined ? [] : [{ _tag: "process", pid } as const]),
                { _tag: "session", sessionId: message.session_id },
                { _tag: "mcp-ready" },
              ]);
            }
            case "assistant": {
              const error = message.error;
              if (
                error === "authentication_failed" ||
                error === "oauth_org_not_allowed" ||
                error === "account_on_hold" ||
                error === "billing_error"
              )
                return Effect.fail(
                  new AgentError({
                    reason: "auth",
                    message:
                      "Claude rejected your login. Run claude in a terminal, sign in again with /login, then retry.",
                  }),
                );
              if (message.parent_tool_use_id !== null) return Effect.succeed([]);
              const events: Array<AgentEvent> = [];
              for (const block of message.message.content) {
                if (block.type === "text" && block.text.trim() !== "")
                  events.push({ _tag: "text", text: block.text });
                if (
                  block.type === "tool_use" &&
                  !QUIET_TOOLS.has(block.name.replace(MCP_PREFIX, ""))
                )
                  events.push({
                    _tag: "tool",
                    id: block.id,
                    ...describeTool(block.name, block.input),
                  });
              }
              return Effect.succeed(events);
            }
            case "user": {
              const content = message.message.content;
              if (message.parent_tool_use_id !== null || typeof content === "string")
                return Effect.succeed([]);
              return Effect.succeed(
                content.flatMap((block): ReadonlyArray<AgentEvent> =>
                  block.type === "tool_result"
                    ? [{ _tag: "tool-done", id: block.tool_use_id, ok: block.is_error !== true }]
                    : [],
                ),
              );
            }
            case "stream_event": {
              const event = message.event;
              if (message.parent_tool_use_id !== null) return Effect.succeed([]);
              if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use" &&
                event.content_block.name === SUBMIT_GUIDE_TOOL
              ) {
                guideCalls.set(event.index, event.content_block.id);
                return Effect.succeed([{ _tag: "composing-guide" }]);
              }
              if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
                const id = guideCalls.get(event.index);
                return Effect.succeed(
                  id === undefined || event.delta.partial_json === ""
                    ? []
                    : [{ _tag: "guide-input", id, json: event.delta.partial_json }],
                );
              }
              if (event.type === "content_block_stop") guideCalls.delete(event.index);
              return Effect.succeed([]);
            }
            case "result":
              return Effect.succeed([
                message.subtype === "success" && !message.is_error
                  ? { _tag: "finished", outcome: "completed", message: null }
                  : {
                      _tag: "finished",
                      outcome: "failed",
                      message:
                        message.subtype === "success"
                          ? oneLine(message.result, 300)
                          : oneLine(message.errors.join(" ") || message.subtype, 300),
                    },
              ]);
            default:
              return Effect.succeed([]);
          }
        };

        /** A plain label from the call's parsed program and paths; the raw call goes to Details. */
        const describeTool = (
          name: string,
          toolInput: Parameters<typeof decodeBashInput>[0],
        ): { label: string; detail: string | null; reads: ReadonlyArray<FileRead> } => {
          const prkitLabel = name.startsWith(MCP_PREFIX)
            ? TOOL_LABELS[name.slice(MCP_PREFIX.length)]
            : undefined;
          if (prkitLabel !== undefined) return { label: prkitLabel, detail: null, reads: [] };
          if (name === "Bash")
            return Option.match(decodeBashInput(toolInput), {
              onNone: () => ({ label: "Ran a command", detail: null, reads: [] }),
              onSome: (bash) => ({
                ...(describeCommand(bash.command, relative) ?? {
                  // A fix's commands are mostly the repository's scripts, worth naming.
                  label:
                    input.access._tag === "write"
                      ? `Ran ${oneLine(bash.command, 60)}`
                      : "Ran a command",
                  reads: [],
                }),
                detail: oneLine(bash.command, 400),
              }),
            });
          const fields = Option.getOrUndefined(decodePathInput(toolInput));
          const detail = oneLine(`${name} ${JSON.stringify(toolInput)}`, 400);
          if (name === "Read") {
            const file = fields?.file_path ?? "a file";
            const start = Math.max(1, fields?.offset ?? 1);
            const end = start + Math.max(1, fields?.limit ?? READ_DEFAULT_LIMIT) - 1;
            const ranged = fields?.offset !== undefined || fields?.limit !== undefined;
            return {
              label: `Read ${relative(file)}${ranged ? `, lines ${start}-${end}` : ""}`,
              detail,
              reads: [{ path: file, lines: { _tag: "range", start, end } }],
            };
          }
          if (name === "Grep")
            return {
              label: `Searched for ${oneLine(fields?.pattern ?? "", 60)}${fields?.path === undefined ? "" : ` in ${relative(fields.path)}`}`,
              detail,
              reads: [],
            };
          if (name === "Glob")
            return {
              label: `Listed files matching ${oneLine(fields?.pattern ?? "", 60)}`,
              detail,
              reads: [],
            };
          if (name === "Edit" || name === "Write")
            return {
              label: `${name === "Edit" ? "Edited" : "Wrote"} ${relative(fields?.file_path ?? "a file")}`,
              detail: null,
              reads: [],
            };
          return { label: `Used ${name.replace(MCP_PREFIX, "")}`, detail, reads: [] };
        };

        let ended = false;
        const messages: AsyncIterator<SDKMessage, void> = {
          next: async () => {
            const next = await turn.next();
            ended = next.done === true;
            return next;
          },
          // A turn cut off before Claude ended it (a stop, or a guide prkit already accepted):
          // Claude only exits on closed input once its reply is done, and the SDK's return
          // waits two seconds before its own SIGTERM, so the group gets one first.
          return: async () => {
            if (!ended && child !== null && !exited(child) && child.pid !== undefined)
              Effect.runSync(signalGroup(child.pid, "SIGTERM"));
            return turn.return();
          },
        };
        return Stream.fromAsyncIterable(
          { [Symbol.asyncIterator]: () => messages },
          (cause) =>
            new AgentError({
              reason: "agent",
              message: `Claude stopped unexpectedly: ${oneLine(stderrTail.trim() || String(cause), 300)}`,
            }),
        ).pipe(
          Stream.mapEffect(toEvents),
          Stream.flatMap((events) => Stream.fromIterable(events)),
          Stream.concat(
            Stream.fromEffect(
              Effect.suspend(() =>
                child === null ? Effect.void : waitForExit(child, "10 seconds"),
              ),
            ).pipe(Stream.drain),
          ),
        );
      }),
    );

  return {
    kind: "claude",
    label: "Claude",
    streamsGuideInput: true,
    check,
    models,
    hasSession,
    runTurn,
    // Claude Code's login works from any folder, so prkit always uses the user's.
    ownLogin: null,
  } satisfies AgentProvider;
});
