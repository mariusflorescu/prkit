import { type AgentModel, type AgentProviderState, childEnv } from "@prkit/contracts";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import {
  AgentError,
  type AgentEvent,
  type AgentProvider,
  type InstanceSetup,
  type TurnInput,
} from "../AgentProvider.ts";
import { TURN_MARKER, watchTurn } from "../turnEnd.ts";
import { toModels } from "./models.ts";
import { Event, Request } from "./protocol.ts";
import { layOutHome, workspaceSandboxProblem } from "./sandbox.ts";
import { findSdk } from "./sdkLoader.ts";
import { CURSOR_SDK_VERSION } from "./sdkPackages.ts";
import { describeToolCall, fileToolsFor } from "./tools.ts";

export const NOT_INSTALLED =
  "Cursor support isn't installed. Install it from Settings > Agents to use Cursor.";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event));

const unavailable = (
  reason: "not-installed" | "logged-out" | "error",
  message: string,
  ownLogin = false,
): AgentProviderState => ({ _tag: "unavailable", reason, message, fix: null, ownLogin });

type Common = { readonly sdk: string; readonly apiKey: string | null };

/** The turn's rules and its task in one message: Cursor takes no system prompt from prkit. */
const turnMessage = (input: TurnInput) =>
  `<prkit-rules>\n${input.instructions}\n</prkit-rules>\n\n${input.prompt}`;

/**
 * One Cursor instance. Cursor's SDK runs in a child process of prkit's (runner.ts), one per
 * check, sign-in or turn, with HOME set to the instance's own home under `$PRKIT_HOME`: its
 * sandbox settings, the key its sign-in saved, and its conversations. The SDK reads none of the
 * user's or the repository's Cursor settings (`settingSources: []`), and a turn offers only the
 * tools in tools.ts, never shell, so Cursor writes guides and edit-only fixes.
 */
export const make = Effect.fn("CursorAgent.make")(function* (setup: InstanceSetup) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const server = yield* ServerConfig;
  const instanceDir = path.resolve(path.join(server.home, "cursor-instances", setup.id));
  const home = path.join(instanceDir, "home");
  /** The instance's own key, when it has one; otherwise the key its sign-in saved. */
  const apiKey = setup.environment.CURSOR_API_KEY ?? null;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  /** The runner next to this module: built into the bundle, or the source in development. */
  const runnerScript = Effect.gen(function* () {
    const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const built = path.join(here, "cursorRunner.mjs");
    return (yield* fs.exists(built)) ? built : path.join(here, "runner.ts");
  }).pipe(
    Effect.mapError(
      () => new AgentError({ reason: "agent", message: "prkit couldn't find its Cursor runner." }),
    ),
  );

  /**
   * Starts the runner on one request; the process lives as long as the scope. Its environment is
   * childEnv's allowlist plus HOME, so no CURSOR_ setting of the server's reaches it, and the
   * key and prkit's MCP token travel in the request on stdin.
   */
  const start = (
    request: (common: Common) => typeof Request.Type,
    options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
  ): Effect.Effect<
    { readonly pid: number; readonly events: Stream.Stream<Event, AgentError> },
    AgentError,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const sdk = yield* provide(findSdk(server.home, process.env));
      if (sdk === null) return yield* new AgentError({ reason: "auth", message: NOT_INSTALLED });
      yield* provide(layOutHome(home));
      const script = yield* runnerScript;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [script], {
          cwd: options.cwd,
          env: childEnv(process.env, {
            ...options.env,
            HOME: home,
            // The packaged server runs on Electron's Node, which needs this to stay Node.
            ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
          }),
          extendEnv: false,
          detached: true,
          forceKillAfter: "3 seconds",
        }),
      );
      yield* Effect.addFinalizer(() =>
        child.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore),
      );
      yield* Stream.make(`${encodeRequest(request({ sdk, apiKey }))}\n`).pipe(
        Stream.encodeText,
        Stream.run(child.stdin),
      );
      yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      // The SDK may print lines of its own: only prkit's events count.
      const events = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.flatMap((line) =>
          Option.match(decodeEvent(line), { onNone: () => Stream.empty, onSome: Stream.make }),
        ),
        Stream.mapError(
          () =>
            new AgentError({ reason: "agent", message: "Cursor's runner stopped unexpectedly." }),
        ),
      );
      return { pid: child.pid, events };
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new AgentError({
            reason: "agent",
            message: `prkit couldn't start Cursor for ${setup.label}. Retry.`,
          }),
        ),
      ),
    );

  /** Every event of a short request, or the runner's own error. */
  const ask = (
    request: (common: Common) => typeof Request.Type,
    timeout: Duration.Input = "30 seconds",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events } = yield* start(request, { cwd: home });
        const all = yield* Stream.runCollect(events);
        const failed = all.find((event) => event.type === "error");
        if (failed !== undefined && failed.type === "error")
          return yield* new AgentError({ reason: failed.reason, message: failed.message });
        return all;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new AgentError({ reason: "agent", message: "Cursor took too long to answer. Retry." }),
          ),
      }),
    );

  const check = Effect.gen(function* () {
    const events = yield* ask((common) => ({ ...common, op: "status" }));
    const status = events.find((event) => event.type === "status");
    if (status === undefined || status.type !== "status")
      return unavailable("error", "Cursor didn't say whether it's signed in. Check again.");
    if (status.via === null)
      return unavailable(
        "logged-out",
        "Cursor isn't signed in for prkit. Sign in with Cursor, or give this agent a CURSOR_API_KEY in Edit.",
      );
    if (status.rejected)
      return status.via === "login"
        ? unavailable(
            "logged-out",
            "Cursor turned down prkit's key: it expired or was deleted. Sign in with Cursor again.",
            true,
          )
        : unavailable(
            "logged-out",
            "Cursor turned down this agent's CURSOR_API_KEY. Fix it in Edit.",
          );
    if (status.via === "key")
      return { _tag: "ready", detail: "Your Cursor API key", ownLogin: false } as const;
    const now = yield* Clock.currentTimeMillis;
    const days =
      status.expiresAtMs === null
        ? null
        : Math.max(0, Math.ceil((status.expiresAtMs - now) / 86_400_000));
    return {
      _tag: "ready",
      detail:
        days === null
          ? "Signed in for prkit"
          : `Signed in for prkit, key good for ${days} more day${days === 1 ? "" : "s"}`,
      ownLogin: true,
    } as const;
  }).pipe(
    Effect.catchTag("AgentError", (error) =>
      Effect.succeed(
        error.message === NOT_INSTALLED
          ? unavailable("not-installed", NOT_INSTALLED)
          : unavailable(error.reason === "auth" ? "logged-out" : "error", error.message),
      ),
    ),
  );

  const version = provide(findSdk(server.home, process.env)).pipe(
    Effect.map((found) => (found === null ? null : CURSOR_SDK_VERSION)),
  );

  const models = (state: AgentProviderState) =>
    state._tag === "unavailable"
      ? Effect.succeed([])
      : ask((common) => ({ ...common, op: "models" })).pipe(
          Effect.map((events): ReadonlyArray<AgentModel> => {
            const found = events.find((event) => event.type === "models");
            return found === undefined || found.type !== "models" ? [] : toModels(found.models);
          }),
          Effect.tapError((error) =>
            Effect.logWarning("Cursor didn't list its models").pipe(
              Effect.annotateLogs({ message: error.message }),
            ),
          ),
          Effect.orElseSucceed((): ReadonlyArray<AgentModel> => []),
        );

  const hasSession = (sessionId: string, cwd: string) =>
    ask((common) => ({ ...common, op: "has-session", sessionId, cwd })).pipe(
      Effect.map((events) => events.some((event) => event.type === "has-session" && event.found)),
      Effect.orElseSucceed(() => false),
    );

  /** Signs out the key prkit's sign-in saved, and says whether Cursor confirms it's gone. */
  const logOut = ask((common) => ({ ...common, op: "logout" })).pipe(
    Effect.map((events) => events.some((event) => event.type === "signed-out" && event.confirmed)),
  );

  const signIn = Stream.unwrap(
    Effect.gen(function* () {
      const { events } = yield* start((common) => ({ ...common, op: "login" }), { cwd: home });
      yield* Effect.logInfo("Cursor sign-in for prkit started").pipe(
        Effect.annotateLogs({ instance: setup.id }),
      );
      let signedIn = false;
      return events.pipe(
        Stream.flatMap((event) => {
          switch (event.type) {
            case "login-url":
              return Stream.make({ url: event.url });
            case "signed-in":
              signedIn = true;
              return Stream.fromEffect(
                Effect.logInfo("Cursor signed in for prkit").pipe(
                  Effect.annotateLogs({ instance: setup.id }),
                ),
              ).pipe(Stream.drain);
            case "error":
              return Stream.fail(new AgentError({ reason: "auth", message: event.message }));
            default:
              return Stream.empty;
          }
        }),
        Stream.concat(
          Stream.suspend(() =>
            signedIn
              ? Stream.empty
              : Stream.fail(
                  new AgentError({
                    reason: "auth",
                    message: "Cursor stopped before the sign-in finished. Try again.",
                  }),
                ),
          ),
        ),
      );
    }),
  );

  const signOut = logOut.pipe(
    Effect.flatMap((confirmed) =>
      confirmed
        ? Effect.logInfo("Cursor signed out for prkit")
        : Effect.fail(
            new AgentError({
              reason: "auth",
              message: "prkit couldn't confirm Cursor signed out. Try again.",
            }),
          ),
    ),
  );

  /**
   * Before the instance is removed: signs out the key its sign-in saved, then deletes its folder.
   * The folder goes only once Cursor confirms the sign-out, so the key is never left behind with
   * nothing to remove it.
   */
  const retire = Effect.gen(function* () {
    if (setup.isDefault) return;
    if (yield* fs.exists(path.join(home, ".cursor", "sdk", "auth.json"))) {
      const confirmed = yield* logOut.pipe(
        Effect.mapError(
          (error) =>
            new AgentError({
              reason: "auth",
              message:
                error.message === NOT_INSTALLED
                  ? `prkit needs Cursor support to sign ${setup.label} out before removing it. Install it, then remove it again.`
                  : `prkit couldn't sign ${setup.label} out of Cursor, so it kept the agent. Try again.`,
            }),
        ),
      );
      if (!confirmed)
        return yield* new AgentError({
          reason: "auth",
          message: `prkit couldn't confirm ${setup.label} is signed out of Cursor, so it kept the agent. Try again.`,
        });
    }
    yield* fs.remove(instanceDir, { recursive: true, force: true });
    yield* Effect.logInfo("Removed a Cursor instance's home").pipe(
      Effect.annotateLogs({ instance: setup.id }),
    );
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new AgentError({
          reason: "agent",
          message: `prkit couldn't delete ${setup.label}'s folder: ${error.message}`,
        }),
      ),
    ),
  );

  const runTurn = (input: TurnInput): Stream.Stream<AgentEvent, AgentError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const problem = yield* provide(workspaceSandboxProblem([input.cwd, ...input.readableDirs]));
        if (problem !== null) return yield* new AgentError({ reason: "agent", message: problem });
        // Before the runner starts, so its end runs once the runner and its group are gone.
        const watch = yield* watchTurn(input.turn).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const params = input.options.flatMap((option) =>
          typeof option.value === "string" ? [{ id: option.id, value: option.value }] : [],
        );
        const { pid, events } = yield* start(
          (common) => ({
            ...common,
            op: "turn",
            cwd: input.cwd,
            readableDirs: [...input.readableDirs],
            message: turnMessage(input),
            resumeSessionId: input.resumeSessionId,
            model: input.model,
            params,
            fileTools: [...fileToolsFor(input.access)],
            mcp: { url: input.mcp.url, token: input.mcp.bearerToken, tools: [...input.tools] },
          }),
          {
            cwd: input.cwd,
            env: { ...input.env, [TURN_MARKER]: input.turn.id, TMPDIR: input.access.tmpDir },
          },
        );
        watch.follow(pid);
        yield* Effect.logInfo(
          input.resumeSessionId === null ? "Cursor turn started" : "Cursor turn resumed",
        ).pipe(Effect.annotateLogs({ instance: setup.id, pid, tools: fileToolsFor(input.access) }));
        const roots = [input.cwd, ...input.readableDirs];
        const relative = (target: string) => {
          for (const root of roots)
            if (target.startsWith(`${root}${path.sep}`)) return target.slice(root.length + 1);
          return target;
        };
        let finished = false;
        const mapped = events.pipe(
          Stream.flatMap((event): Stream.Stream<AgentEvent, AgentError> => {
            switch (event.type) {
              case "session":
                return Stream.make({ _tag: "session", sessionId: event.sessionId });
              case "text":
                return Stream.make({ _tag: "text", text: event.text });
              case "tool":
                return Stream.fromIterable(describeToolCall(event, relative));
              case "tool-done":
                return Stream.make({ _tag: "tool-done", id: event.callId, ok: event.ok });
              case "finished":
                finished = true;
                return Stream.make({
                  _tag: "finished",
                  outcome: event.outcome,
                  message: event.message,
                });
              case "error":
                return Stream.fail(
                  new AgentError({ reason: event.reason, message: event.message }),
                );
              default:
                return Stream.empty;
            }
          }),
          Stream.takeUntil((event) => event._tag === "finished"),
          Stream.concat(
            Stream.suspend(() =>
              finished
                ? Stream.empty
                : Stream.fail(
                    new AgentError({
                      reason: "agent",
                      message: "Cursor stopped before the turn finished. Retry.",
                    }),
                  ),
            ),
          ),
        );
        return Stream.fromIterable<AgentEvent>([{ _tag: "process", pid }]).pipe(
          Stream.concat(mapped),
        );
      }),
    );

  return {
    instance: setup.id,
    kind: "cursor",
    label: setup.label,
    // Cursor keeps an instance's conversations in its own home.
    group: `cursor:${home}`,
    version,
    retire,
    // Tool calls arrive only once they start, without their input, so Cursor drafts with submit_draft.
    streamsGuideInput: false,
    check,
    models,
    hasSession,
    runTurn,
    ownLogin: { signIn, signOut },
  } satisfies AgentProvider;
});
