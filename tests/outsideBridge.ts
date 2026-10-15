import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Message = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
    method: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  }),
);
const decodeMessage = Schema.decodeUnknownOption(Message);
export type Answer = Omit<typeof Message.Type, "id" | "method">;

const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
  structuredContent: Schema.optionalKey(Schema.Json),
});
const Initialized = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String }),
  instructions: Schema.optionalKey(Schema.String),
});

/**
 * An MCP client on the other end of prkit's launcher, the way Claude Code runs it: the
 * launcher at `<home>/bin/prkit-mcp` over stdio, one JSON-RPC message a line. Only the
 * environment a client would pass reaches it, and no token.
 */
export const startBridge = (home: string, clientName = "e2e client") => {
  const child = NodeChildProcess.spawn(NodePath.join(home, "bin", "prkit-mcp"), [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const waiting = new Map<number, (answer: Answer) => void>();
  const notifications: string[] = [];
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    Option.match(decodeMessage(line), {
      onNone: () => {},
      onSome: ({ id, method, ...answer }) => {
        if (method !== undefined && (id === undefined || id === null)) notifications.push(method);
        else if (typeof id === "number") waiting.get(id)?.(answer);
      },
    });
  });
  let next = 1;
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object = {}) =>
    new Promise<Answer>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`No answer to ${method} in 120s. Bridge stderr: ${stderr}`));
      }, 120_000);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(answer);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const initialize = async () => {
    const answer = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return Schema.decodeUnknownSync(Initialized)(answer.result);
  };
  const tools = async () =>
    Schema.decodeUnknownSync(ToolList)((await request("tools/list")).result)
      .tools.map((tool) => tool.name)
      .sort();
  /** A tool call's result, or the JSON-RPC error for one the server doesn't offer. */
  const call = async (name: string, args: object = {}) => {
    const answer = await request("tools/call", { name, arguments: args });
    if (answer.error !== undefined) return { rpcError: answer.error.message } as const;
    const result = Schema.decodeUnknownSync(ToolResult)(answer.result);
    const text = result.content.map((part) => part.text ?? "").join("\n");
    return { isError: result.isError === true, text, json: result.structuredContent } as const;
  };
  return {
    initialize,
    tools,
    call,
    notifications,
    stderr: () => stderr,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill("SIGTERM"), 3_000).unref();
      }),
  };
};
export type Bridge = ReturnType<typeof startBridge>;
