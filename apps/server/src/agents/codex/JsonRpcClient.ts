import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../../package.json" with { type: "json" };
import { AgentError } from "../AgentProvider.ts";
import type { CodexApprovals } from "./approvals.ts";

const Id = Schema.Union([Schema.String, Schema.Number]);
const Message = Schema.Union([
  Schema.Struct({ id: Id, result: Schema.Json }),
  Schema.Struct({ id: Id, error: Schema.Struct({ code: Schema.Number, message: Schema.String }) }),
  Schema.Struct({
    id: Schema.optionalKey(Id),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Json),
  }),
]);
export type Notification = { readonly method: string; readonly params: Schema.Json };
/** Codex's answer to one request: its result, or its own reason for refusing it. */
type Reply = { readonly result: Schema.Json } | { readonly refused: string };

/** How a request that fails reads to the user. */
export interface RequestWording {
  /** Codex refused it; `reason` is Codex's own message. */
  readonly refused: (reason: string) => AgentError;
  /** Codex didn't answer within 30 seconds. */
  readonly tooSlow: AgentError;
}

/** A request in a guide or fix turn, where the login is the usual cause of a refusal. */
const inTurn = (method: string): RequestWording => ({
  refused: (reason) =>
    new AgentError({
      reason: "agent",
      message: `Codex rejected a request (${reason}). Check your Codex login and retry.`,
    }),
  tooSlow: new AgentError({
    reason: "agent",
    message: `Codex took too long to answer ${method}.`,
  }),
});

export const make = Effect.fn("CodexJsonRpcClient.make")(function* (options: {
  readonly executable: string;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  /** Root `-c` overrides, which outrank every config.toml Codex reads. */
  readonly config: ReadonlyArray<string>;
  /** Answers Codex's approval requests; without it every request is refused. */
  readonly approvals?: CodexApprovals;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.unbounded<string>();
  const notifications = yield* Queue.unbounded<Notification, AgentError>();
  const pending = new Map<string | number, Deferred.Deferred<Reply, AgentError>>();
  let nextId = 0;
  let closed: AgentError | null = null;
  const terminate = (error: AgentError) =>
    Effect.gen(function* () {
      if (closed !== null) return;
      closed = error;
      for (const waiter of pending.values()) yield* Deferred.fail(waiter, error);
      pending.clear();
      yield* Queue.fail(notifications, error);
    });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        options.executable,
        [...options.config.flatMap((pair) => ["-c", pair]), "app-server", "--listen", "stdio://"],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.env,
          extendEnv: false,
          detached: true,
          forceKillAfter: "3 seconds",
        },
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "agent",
            message: "Couldn't start Codex. Check its installation and retry.",
          }),
      ),
    );
  yield* Effect.addFinalizer(() =>
    terminate(new AgentError({ reason: "agent", message: "Codex's connection closed." })).pipe(
      Effect.andThen(child.kill({ forceKillAfter: "3 seconds" })),
      Effect.catchTag("PlatformError", () => Effect.void),
      Effect.andThen(
        Effect.logInfo("Codex process stopped").pipe(Effect.annotateLogs({ pid: child.pid })),
      ),
    ),
  );
  yield* Effect.logInfo("Codex started").pipe(
    Effect.annotateLogs({ pid: child.pid, cwd: options.cwd ?? null }),
  );
  const send = (message: Schema.Json) =>
    Queue.offer(outgoing, `${JSON.stringify(message)}\n`).pipe(Effect.asVoid);
  const handle = (line: string) =>
    Effect.gen(function* () {
      const message = yield* Schema.decodeEffect(Schema.fromJsonString(Message))(line).pipe(
        Effect.mapError(
          () =>
            new AgentError({
              reason: "agent",
              message: "Codex sent an invalid protocol message. Update Codex and retry.",
            }),
        ),
      );
      if ("method" in message) {
        const params = message.params ?? null;
        if (message.id !== undefined) {
          // Only prkit's own policy answers; nothing interactive widens a turn's permissions.
          const result =
            options.approvals === undefined
              ? null
              : yield* options.approvals.answer(message.method, params);
          yield* send(
            result === null
              ? {
                  id: message.id,
                  error: {
                    code: -32601,
                    message: "prkit doesn't allow interactive requests in its agent turns.",
                  },
                }
              : { id: message.id, result },
          );
        } else {
          options.approvals?.seen(message.method, params);
          yield* Queue.offer(notifications, { method: message.method, params });
        }
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      yield* Deferred.succeed(
        waiter,
        "result" in message
          ? { result: message.result }
          : { refused: message.error.message.replaceAll(/\s+/g, " ").trim().slice(0, 200) },
      );
    });
  const pipeFailure = () =>
    terminate(
      new AgentError({
        reason: "agent",
        message: "Codex's connection stopped unexpectedly.",
      }),
    );
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.encodeText,
    Stream.run(child.stdin),
    Effect.catchTag("PlatformError", pipeFailure),
    Effect.forkScoped,
  );
  yield* child.stderr.pipe(
    Stream.runDrain,
    Effect.catchTag("PlatformError", pipeFailure),
    Effect.forkScoped,
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.runForEach(handle),
    Effect.andThen(pipeFailure),
    Effect.catchTags({ AgentError: terminate, PlatformError: pipeFailure }),
    Effect.forkScoped,
  );
  yield* child.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.logInfo("Codex exited").pipe(Effect.annotateLogs({ pid: child.pid, code })),
    ),
    Effect.andThen(pipeFailure),
    Effect.catchTag("PlatformError", pipeFailure),
    Effect.forkScoped,
  );

  const request = <A>(
    method: string,
    params: Schema.Json,
    response: Schema.Codec<A, Schema.Json>,
    wording: RequestWording = inTurn(method),
  ) =>
    Effect.gen(function* () {
      const id = ++nextId;
      const waiter = yield* Deferred.make<Reply, AgentError>();
      if (closed !== null) return yield* closed;
      pending.set(id, waiter);
      return yield* send({ id, method, params }).pipe(
        Effect.andThen(Deferred.await(waiter)),
        Effect.flatMap((reply) =>
          "refused" in reply
            ? Effect.fail(wording.refused(reply.refused))
            : Effect.succeed(reply.result),
        ),
        Effect.flatMap(Schema.decodeEffect(response)),
        Effect.mapError((error) =>
          error._tag === "AgentError"
            ? error
            : new AgentError({
                reason: "agent",
                message: `Codex returned an unexpected ${method} response. Update Codex and retry.`,
              }),
        ),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(wording.tooSlow),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
    });
  yield* request(
    "initialize",
    {
      clientInfo: { name: "prkit", title: "prkit", version: packageJson.version },
      capabilities: { experimentalApi: false },
    },
    Schema.Json,
  );
  yield* send({ method: "initialized" });
  return { pid: child.pid, request, notifications: Stream.fromQueue(notifications) };
});
