// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off
import {
  OUTSIDE_BRIDGE_HEADER,
  OUTSIDE_CLIENT_HEADER,
  OUTSIDE_MCP_PATH,
  OUTSIDE_NOT_OPEN,
  OUTSIDE_OFF,
} from "@prkit/contracts/outsideAgents";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ssePayloads } from "../outside/sse.ts";
import { discover } from "../outside/discovery.ts";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  code: Schema.Literals([1, 2, 3, 4]),
  message: Schema.String,
}) {}

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
    result: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);
const Result = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  structuredContent: Schema.optionalKey(Schema.Json),
});
const Initialized = Schema.Struct({ protocolVersion: Schema.String });
const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolFailure = Schema.Struct({ code: Schema.String });

export const callTool = (home: string, name: string, args: Schema.Json) =>
  Effect.gen(function* () {
    const bridgeId = "prkit-cli";
    // Only retry the handshake. A tool call with a lost response may already have started work.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = discover(home);
      if (found === null) return yield* new CliFailure({ code: 3, message: OUTSIDE_NOT_OPEN });
      if (found._tag === "off") return yield* new CliFailure({ code: 3, message: OUTSIDE_OFF });
      let session: string | null = null;
      let protocol = "2025-06-18";
      yield* Effect.addFinalizer(() => {
        if (session === null) return Effect.void;
        const currentSession = session;
        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(`http://127.0.0.1:${found.port}${OUTSIDE_MCP_PATH}`, {
              method: "DELETE",
              headers: {
                authorization: `Bearer ${found.token}`,
                "mcp-session-id": currentSession,
                "mcp-protocol-version": protocol,
                [OUTSIDE_CLIENT_HEADER]: "prkit CLI",
                [OUTSIDE_BRIDGE_HEADER]: bridgeId,
              },
              signal: AbortSignal.timeout(1000),
            });
            await response.body?.cancel();
          },
          catch: () =>
            new CliFailure({ code: 1, message: "prkit's client session already ended." }),
        }).pipe(Effect.catchTag("CliFailure", () => Effect.void));
      });
      const request = (id: number | undefined, method: string, params: Schema.Json) =>
        Effect.gen(function* () {
          let receivedHeaders = false;
          const { response, text } = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`http://127.0.0.1:${found.port}${OUTSIDE_MCP_PATH}`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  authorization: `Bearer ${found.token}`,
                  [OUTSIDE_CLIENT_HEADER]: "prkit CLI",
                  [OUTSIDE_BRIDGE_HEADER]: bridgeId,
                  ...(session === null ? {} : { "mcp-session-id": session }),
                  "mcp-protocol-version": protocol,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(name === "wait_for" ? 610_000 : 60_000),
                ]),
              });
              session = response.headers.get("mcp-session-id") ?? session;
              receivedHeaders = true;
              return { response, text: await response.text() };
            },
            catch: () =>
              new CliFailure({
                code: receivedHeaders ? 1 : 3,
                message: receivedHeaders
                  ? "prkit's answer was interrupted. Check its state before retrying work."
                  : "prkit couldn't be reached. Open prkit and try again. Inside a coding agent sandbox, allow network access to 127.0.0.1 (Codex: sandbox_workspace_write.network_access = true; Claude Code: allow local network access).",
              }),
          });
          if ([401, 403, 404].includes(response.status)) return { _tag: "reconnect" } as const;
          if (!response.ok)
            return yield* new CliFailure({
              code: 1,
              message: `prkit answered with HTTP ${response.status}. Try again.`,
            });
          if (id === undefined) return { _tag: "result", value: null } as const;
          const payloads = (response.headers.get("content-type") ?? "").includes(
            "text/event-stream",
          )
            ? ssePayloads(text)
            : [text];
          for (const payload of payloads.filter((line) => line.trim() !== "")) {
            const envelope = yield* Schema.decodeEffect(Envelope)(payload).pipe(
              Effect.mapError(
                () => new CliFailure({ code: 1, message: "prkit returned an unreadable answer." }),
              ),
            );
            if (envelope.id !== id) continue;
            if (envelope.error !== undefined)
              return yield* new CliFailure({ code: 1, message: envelope.error.message });
            if (envelope.result !== undefined)
              return { _tag: "result", value: envelope.result } as const;
          }
          return yield* new CliFailure({ code: 1, message: "prkit returned no answer." });
        });
      const initialized = yield* request(1, "initialize", {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "prkit CLI", version: "1.0.0" },
      });
      if (initialized._tag === "reconnect") continue;
      protocol = (yield* Schema.decodeUnknownEffect(Initialized)(initialized.value))
        .protocolVersion;
      const ack = yield* request(undefined, "notifications/initialized", {});
      if (ack._tag === "reconnect") continue;
      const listed = yield* request(2, "tools/list", {});
      if (listed._tag === "reconnect") continue;
      const tools = yield* Schema.decodeUnknownEffect(Tools)(listed.value);
      if (!tools.tools.some((tool) => tool.name === name))
        return yield* new CliFailure({
          code: 4,
          message:
            "Turn on Read and start work in prkit > Settings > Outside agents. If it is already on, update prkit so it supports this command.",
        });
      const called = yield* request(3, "tools/call", { name, arguments: args });
      if (called._tag === "reconnect") continue; // Auth rejected the call before dispatch.
      const result = yield* Schema.decodeUnknownEffect(Result)(called.value);
      const text = result.content.map((part) => part.text ?? "").join("\n");
      if (result.isError === true) {
        const failure = Schema.decodeUnknownOption(ToolFailure)(result.structuredContent);
        return yield* new CliFailure({
          code: failure._tag === "Some" && failure.value.code === "not-allowed" ? 4 : 1,
          message: text,
        });
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text);
    }
    const now = discover(home);
    return yield* new CliFailure({
      code: 3,
      message: now?._tag === "off" ? OUTSIDE_OFF : OUTSIDE_NOT_OPEN,
    });
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new CliFailure({
          code: 1,
          message: "prkit returned an unreadable answer. Update prkit and try again.",
        }),
      ),
    ),
  );
