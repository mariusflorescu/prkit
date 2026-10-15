import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ToolResult } from "./fileTools.ts";

/**
 * prkit's MCP tools (submit_guide, finish_fixes...) as Cursor sees them: tools of prkit's runner
 * that call prkit's MCP server themselves. Cursor fails closed on an MCP server it would have to
 * approve calls to, and the bearer token would sit in its configuration; this way the token stays
 * in the runner and never reaches the model, its tool results or a log.
 */

export interface PrkitTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, Schema.MutableJson>>;
  readonly run: (args: Readonly<Record<string, Schema.Json>>) => Promise<ToolResult>;
}

const Reply = Schema.Struct({
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const Listed = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      inputSchema: Schema.Record(Schema.String, Schema.MutableJson),
    }),
  ),
});
const Called = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});

const UNREACHABLE = "prkit's server didn't answer this call. Try it again.";

export class PrkitUnreachable extends Error {}

/**
 * Connects to prkit's MCP server and offers the tools in `names` it lists. Fails with
 * PrkitUnreachable when the server can't be reached or turns the token down.
 */
export const connectPrkitTools = async (
  server: { readonly url: string; readonly token: string },
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<PrkitTool>> => {
  let session: string | null = null;
  let nextId = 1;
  /** No answer ever carries the token, even if the server put it in one. */
  const scrub = (text: string) => text.replaceAll(server.token, "[hidden]");

  const post = async (body: Readonly<Record<string, Schema.Json>>) => {
    // @effect-diagnostics-next-line globalFetch:off -- a child process outside the Effect runtime
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(session === null ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    }).catch(() => null);
    if (response === null || !response.ok) throw new PrkitUnreachable(UNREACHABLE);
    session = response.headers.get("mcp-session-id") ?? session;
    return response.text();
  };

  /** One JSON-RPC request; the answer is JSON or a server-sent event holding it. */
  const request = async (method: string, params: Schema.JsonObject) => {
    const text = await post({ id: nextId++, method, params });
    const json = text.includes("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    const reply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))(json);
    if (Option.isNone(reply)) throw new PrkitUnreachable(UNREACHABLE);
    return reply.value;
  };

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "prkit-cursor-runner", version: "1" },
  });
  await post({ method: "notifications/initialized", params: {} });
  const listed = Schema.decodeUnknownOption(Listed)((await request("tools/list", {})).result);
  if (Option.isNone(listed)) throw new PrkitUnreachable(UNREACHABLE);

  return listed.value.tools
    .filter((tool) => names.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      run: async (args) => {
        try {
          const reply = await request("tools/call", { name: tool.name, arguments: args });
          if (reply.error !== undefined) return { ok: false, text: scrub(reply.error.message) };
          const called = Schema.decodeUnknownOption(Called)(reply.result);
          if (Option.isNone(called)) return { ok: false, text: UNREACHABLE };
          const text = called.value.content.flatMap((part) =>
            part.text === undefined ? [] : [part.text],
          );
          return { ok: called.value.isError !== true, text: scrub(text.join("\n")) };
        } catch {
          return { ok: false, text: UNREACHABLE };
        }
      },
    }));
};
