// @effect-diagnostics globalDate:off -- a child process outside the Effect runtime, checking a key's expiry
// Cursor's runner: the child process that hosts Cursor's SDK for one check, sign-in or turn, so
// the SDK never runs inside prkit's server. prkit starts it with HOME set to the instance's own
// home, writes one request line on stdin, and reads event lines (protocol.ts) until it exits.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a child process outside the Effect runtime, resolving the checkout's real path
import * as NodeFs from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a child process outside the Effect runtime, resolving a tool's path for the log
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentOptions, InteractionUpdate, SDKAgent, SDKCustomTool } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkoutPaths } from "../checkoutPaths.ts";
import { makeFileTools, type ToolResult } from "./fileTools.ts";
import { connectPrkitTools } from "./prkitTools.ts";
import { type Event, Request, type TurnRequest } from "./protocol.ts";
import { loadSdk } from "./sdkLoader.ts";
import { ALLOWED_TOOLS, CUSTOM_TOOLS_SERVER, DENIED_TOOLS } from "./tools.ts";

/** Where Cursor's own sign-in sends keys. A saved login for anywhere else is refused. */
const CURSOR_BACKEND = "https://api2.cursor.sh";

type Sdk = Awaited<ReturnType<typeof loadSdk>>;

const emit = (event: Event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim().slice(0, 300);

const readRequest = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return Schema.decodeUnknownSync(Schema.fromJsonString(Request))(text.trim());
};

/** The key a request runs on: the instance's own, else the one its sign-in saved in this home. */
const keyFor = async (sdk: Sdk, apiKey: string | null) => {
  if (apiKey !== null) return { key: apiKey, via: "key", expiresAtMs: null } as const;
  const saved = await new sdk.FileCredentialStore().load();
  if (saved === undefined) return null;
  if (saved.backendUrl.replace(/\/+$/, "") !== CURSOR_BACKEND)
    throw new RefusedError(
      "prkit's Cursor sign-in points at a server other than Cursor's. Sign out and sign in again.",
    );
  if (saved.apiKeyExpiresAtMs !== undefined && saved.apiKeyExpiresAtMs <= Date.now()) return null;
  return { key: saved.apiKey, via: "login", expiresAtMs: saved.apiKeyExpiresAtMs ?? null } as const;
};

class RefusedError extends Error {}

const status = async (sdk: Sdk, apiKey: string | null) => {
  const key = await keyFor(sdk, apiKey);
  if (key === null) return emit({ type: "status", via: null, expiresAtMs: null, rejected: false });
  try {
    await sdk.Cursor.me({ apiKey: key.key });
    emit({ type: "status", via: key.via, expiresAtMs: key.expiresAtMs, rejected: false });
  } catch (error) {
    if (!(error instanceof sdk.AuthenticationError)) throw error;
    emit({ type: "status", via: key.via, expiresAtMs: key.expiresAtMs, rejected: true });
  }
};

const models = async (sdk: Sdk, apiKey: string | null) => {
  const key = await keyFor(sdk, apiKey);
  if (key === null) return emit({ type: "models", models: [] });
  const list = await sdk.Cursor.models.list({ apiKey: key.key });
  // Only what protocol.ts names is read; the rest of each entry is ignored.
  emit({ type: "models", models: list });
};

const login = async (sdk: Sdk) => {
  try {
    await sdk.Cursor.auth.login({
      openBrowser: false,
      store: new sdk.FileCredentialStore(),
      apiKeyName: "prkit",
      onLoginUrl: (url) => emit({ type: "login-url", url }),
    });
  } catch (error) {
    // The SDK stops waiting about 25 minutes after the page opens, or when the page is declined.
    if (!(error instanceof sdk.AuthenticationError)) throw error;
    return emit({
      type: "error",
      reason: "auth",
      message:
        "The Cursor sign-in page expired or was declined before it was approved. Sign in again.",
    });
  }
  emit({ type: "signed-in" });
};

const logout = async (sdk: Sdk) => {
  const store = new sdk.FileCredentialStore();
  await sdk.Cursor.auth.logout({ store });
  const after = await sdk.Cursor.auth.status({ store });
  emit({ type: "signed-out", confirmed: after.status === "logged-out" });
};

/** The agent's conversations live in its home, whichever checkout a turn ran in. */
const agentStore = (sdk: Sdk) => new sdk.JsonlLocalAgentStore(`${process.env.HOME ?? ""}/agents`);

const hasSession = async (sdk: Sdk, apiKey: string | null, sessionId: string, cwd: string) => {
  const key = await keyFor(sdk, apiKey);
  try {
    await sdk.Agent.get(sessionId, {
      cwd,
      store: agentStore(sdk),
      ...(key === null ? {} : { apiKey: key.key }),
    });
    emit({ type: "has-session", found: true });
  } catch {
    emit({ type: "has-session", found: false });
  }
};

/**
 * A tool call's update as the runner reports it. Only names, paths and patterns: never content.
 * Every call Cursor makes is one of the custom tools the turn gave it (customToolsFor).
 */
const toolEvent = (update: InteractionUpdate, cwd: string): Event | null => {
  if (update.type === "text-delta") return { type: "text", text: update.text };
  if (update.type === "tool-call-completed") {
    const call = update.toolCall;
    // A tool that refused still returns, as a result marked as an error.
    const refused =
      call.type === "mcp" && call.result?.status === "success" && call.result.value.isError;
    return {
      type: "tool-done",
      callId: update.callId,
      ok: call.result?.status === "success" && !refused,
    };
  }
  if (update.type !== "tool-call-started") return null;
  const call = update.toolCall;
  const base = { type: "tool", callId: update.callId, path: null, pattern: null } as const;
  if (call.type !== "mcp") return { ...base, tool: "other", name: call.type };
  const name = call.args.toolName ?? "";
  // A server Cursor doesn't have: the call fails without running anything.
  if (call.args.providerIdentifier !== CUSTOM_TOOLS_SERVER) return { ...base, tool: "mcp", name };
  const field = (key: string) => {
    const value = call.args.args?.[key];
    return typeof value === "string" ? value : null;
  };
  if (!FILE_TOOLS.has(name)) return { ...base, tool: "prkit", name };
  const path = field("path");
  return {
    ...base,
    tool: name,
    name,
    path: path === null ? null : NodePath.resolve(cwd, path),
    pattern: field("pattern"),
  };
};

const FILE_TOOLS = new Set(["read_file", "list_dir", "glob", "grep", "write_file", "edit_file"]);

const asCustomTool = (tool: {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, Schema.MutableJson>>;
  readonly readOnly: boolean;
  readonly run: (args: Readonly<Record<string, Schema.Json>>) => Promise<ToolResult>;
}): SDKCustomTool => ({
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
  execute: async (args) => {
    const result = await tool.run(args);
    return { content: [{ type: "text", text: result.text }], isError: !result.ok };
  },
});

/**
 * The only tools Cursor gets for a turn: prkit's file tools, confined to the checkout, and
 * prkit's MCP tools, called by the runner with the token Cursor never sees.
 */
const customToolsFor = async (request: TurnRequest) => {
  const checkout = await NodeFs.realpath(request.cwd);
  const paths = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* checkoutPaths(fs, path, { checkout, readable: request.readableDirs });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const files = makeFileTools({
    checkout,
    paths,
    writes: request.fileTools.includes("write_file"),
  });
  const tools: Record<string, SDKCustomTool> = {};
  for (const name of request.fileTools) {
    const tool = files[name];
    if (tool !== undefined) tools[name] = asCustomTool(tool);
  }
  const prkit = await connectPrkitTools(request.mcp, request.mcp.tools);
  for (const tool of prkit) tools[tool.name] = asCustomTool({ ...tool, readOnly: false });
  return tools;
};

/** The model the catalog marks as default (models.ts): Cursor's "auto" when listed, else its first. */
const defaultModel = async (sdk: Sdk, apiKey: string) => {
  const list = await sdk.Cursor.models.list({ apiKey });
  const found = list.find((model) => model.id === "auto" || model.id === "default") ?? list[0];
  if (found === undefined) throw new Error("Cursor listed no models for this account.");
  return found.id;
};

let stop: (() => Promise<void>) | null = null;

const turn = async (sdk: Sdk, request: TurnRequest) => {
  const key = await keyFor(sdk, request.apiKey);
  if (key === null)
    return emit({
      type: "error",
      reason: "auth",
      message: "Cursor isn't signed in. Sign in with Cursor in Settings > Agents, then retry.",
    });
  const customTools = await customToolsFor(request);
  const model = {
    id: request.model ?? (await defaultModel(sdk, key.key)),
    params: [...request.params],
  };
  const options: AgentOptions = {
    apiKey: key.key,
    model,
    tools: [...ALLOWED_TOOLS],
    disallowedTools: [...DENIED_TOOLS],
    local: {
      cwd: request.cwd,
      dirs: [...request.readableDirs],
      store: agentStore(sdk),
      settingSources: [],
      sandboxOptions: { enabled: true },
      customTools,
    },
  };
  const agent: SDKAgent =
    request.resumeSessionId === null
      ? await sdk.Agent.create(options)
      : await sdk.Agent.resume(request.resumeSessionId, options);
  emit({ type: "session", sessionId: agent.agentId });
  const run = await agent.send(request.message, {
    model,
    local: { customTools },
    onDelta: ({ update }) => {
      const event = toolEvent(update, request.cwd);
      if (event !== null) emit(event);
    },
  });
  stop = () => run.cancel();
  const result = await run.wait();
  emit({
    type: "finished",
    outcome:
      result.status === "finished"
        ? "completed"
        : result.status === "cancelled"
          ? "interrupted"
          : "failed",
    message: result.status === "error" ? "Cursor stopped with an error. Retry." : null,
  });
  agent.close();
};

const failure = (sdk: Sdk | null, error: Error): Event => {
  if (error instanceof RefusedError)
    return { type: "error", reason: "auth", message: error.message };
  if (sdk !== null && error instanceof sdk.AuthenticationError)
    return {
      type: "error",
      reason: "auth",
      message: "Cursor turned down prkit's key. Sign in with Cursor again in Settings > Agents.",
    };
  return { type: "error", reason: "agent", message: `Cursor stopped: ${oneLine(error.message)}` };
};

const main = async () => {
  let sdk: Sdk | null = null;
  try {
    const request = await readRequest();
    sdk = await loadSdk(request.sdk);
    switch (request.op) {
      case "status":
        return await status(sdk, request.apiKey);
      case "models":
        return await models(sdk, request.apiKey);
      case "login":
        return await login(sdk);
      case "logout":
        return await logout(sdk);
      case "has-session":
        return await hasSession(sdk, request.apiKey, request.sessionId, request.cwd);
      case "turn":
        return await turn(sdk, request);
    }
  } catch (error) {
    emit(failure(sdk, error instanceof Error ? error : new Error(String(error))));
    process.exitCode = 1;
  }
};

// prkit stops a turn with SIGTERM, then kills the runner's whole process group.
process.on("SIGTERM", () => {
  void (stop?.() ?? Promise.resolve()).finally(() => process.exit(143));
});

await main();
// The SDK keeps timers and sockets open; the runner's work is done once main returns.
process.exit();
