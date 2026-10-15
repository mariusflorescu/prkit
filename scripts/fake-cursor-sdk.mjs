/**
 * A stand-in for Cursor's SDK (`@cursor/sdk`), so tests can install, sign in and run Cursor
 * without Cursor. `tests/fakeCursor.ts` lays it out as an SDK package folder, with the folder
 * that steers it baked in as CONTROL, and prkit loads it through PRKIT_CURSOR_SDK_PATH or the
 * installer. Plain JavaScript: the installer puts it under node_modules, where Node strips no types.
 *
 * In CONTROL:
 *   approve-login  a sign-in waiting in the browser finishes
 *   reject-keys    Cursor turns every key down
 *   hold           a turn keeps writing until the file is removed
 *   runs.log       each turn appends what it was started with: tools, setting sources, sandbox,
 *                  MCP server names, cwd, and whether it resumed
 *
 * A guide turn reports progress and submits a guide with one chapter holding every file the
 * prompt lists, through prkit's MCP server; a fix adds `stand-in.md` and reports every comment
 * fixed. Keys are `stand-in-...`; anything else is turned down.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CONTROL = process.env.FAKE_CURSOR_CONTROL ?? "";
const flagged = (name) => CONTROL !== "" && NodeFS.existsSync(NodePath.join(CONTROL, name));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AuthenticationError extends Error {}
export class ConfigurationError extends Error {}

const authPath = () => NodePath.join(process.env.HOME ?? "", ".cursor", "sdk", "auth.json");

export class FileCredentialStore {
  constructor(filePath = authPath()) {
    this.filePath = filePath;
  }
  async load() {
    return NodeFS.existsSync(this.filePath)
      ? JSON.parse(NodeFS.readFileSync(this.filePath, "utf8"))
      : undefined;
  }
  async save(credentials) {
    NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
    NodeFS.writeFileSync(this.filePath, JSON.stringify(credentials), { mode: 0o600 });
  }
  async clear() {
    NodeFS.rmSync(this.filePath, { force: true });
  }
}

export class JsonlLocalAgentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }
  file() {
    return NodePath.join(this.rootDir, "agents.json");
  }
  list() {
    return NodeFS.existsSync(this.file())
      ? JSON.parse(NodeFS.readFileSync(this.file(), "utf8"))
      : [];
  }
  add(id) {
    NodeFS.mkdirSync(this.rootDir, { recursive: true });
    NodeFS.writeFileSync(this.file(), JSON.stringify([...this.list(), id]));
  }
}

const checkKey = (apiKey) => {
  if (flagged("reject-keys") || !String(apiKey ?? "").startsWith("stand-in-"))
    throw new AuthenticationError("Invalid User API Key");
};

export const Cursor = {
  me: async ({ apiKey } = {}) => {
    checkKey(apiKey);
    return { apiKeyName: "prkit", createdAt: new Date(0).toISOString() };
  },
  models: {
    list: async ({ apiKey } = {}) => {
      checkKey(apiKey);
      return [
        { id: "auto", displayName: "Auto" },
        {
          id: "stand-in-1",
          displayName: "Stand-in 1",
          description: "A stand-in model",
          parameters: [
            {
              id: "effort",
              displayName: "Effort",
              values: [
                { value: "low", displayName: "Low" },
                { value: "high", displayName: "High" },
              ],
            },
          ],
          variants: [
            { params: [{ id: "effort", value: "high" }], displayName: "High", isDefault: true },
          ],
        },
      ];
    },
  },
  auth: {
    login: async ({ onLoginUrl, store }) => {
      onLoginUrl?.("http://127.0.0.1:9/cursor-stand-in-login");
      while (!flagged("approve-login")) await sleep(200);
      const expires = Date.now() + 90 * 86_400_000;
      await store.save({
        version: 1,
        backendUrl: "https://api2.cursor.sh",
        apiKey: "stand-in-login-key",
        apiKeyExpiresAtMs: expires,
        createdAtMs: Date.now(),
      });
      return { apiKey: "stand-in-login-key", apiKeyExpiresAtMs: expires };
    },
    logout: async ({ store }) => store.clear(),
    status: async ({ store }) => {
      const saved = await store.load();
      return saved === undefined
        ? { status: "logged-out" }
        : { status: "logged-in", backendUrl: saved.backendUrl };
    },
  },
};

const changedFiles = (prompt) => {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^Changed files \(\d+\):$/.test(line));
  return lines.slice(start + 1).flatMap((line) => {
    const match = /^- (?:added|modified|removed|renamed) (?:.+ -> )?(.+?) \(\+\d+ -\d+/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
};

/** One JSON-RPC call to an MCP server over streamable HTTP; the answer is JSON or one SSE event. */
const mcpClient = (server) => {
  let session = null;
  let nextId = 1;
  return async (method, params, notification = false) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(session === null ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify(
        notification
          ? { jsonrpc: "2.0", method, params }
          : { jsonrpc: "2.0", id: nextId++, method, params },
      ),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    if (notification) return { ok: response.ok, text };
    const body = text.includes("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    let reply = null;
    try {
      reply = JSON.parse(body);
    } catch {
      reply = null;
    }
    return {
      ok:
        response.ok &&
        reply !== null &&
        reply.error === undefined &&
        reply.result?.isError !== true,
      text: body,
    };
  };
};

class StandInAgent {
  constructor(agentId, options) {
    this.agentId = agentId;
    this.options = options;
  }
  async send(message, sendOptions = {}) {
    const onDelta = sendOptions.onDelta ?? (() => {});
    const servers = sendOptions.mcpServers ?? this.options.mcpServers ?? {};
    const [name, server] = Object.entries(servers)[0] ?? [null, null];
    const state = { cancelled: false };
    const call = async (mcp, tool, args) => {
      const callId = NodeCrypto.randomUUID();
      const toolCall = { type: "mcp", args: { providerIdentifier: name, toolName: tool, args } };
      await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
      const result = await mcp("tools/call", { name: tool, arguments: args });
      await onDelta({
        update: {
          type: "tool-call-completed",
          callId,
          toolCall: { ...toolCall, result: { status: result.ok ? "success" : "error" } },
        },
      });
      return result;
    };
    const work = async () => {
      if (server === null) return { status: "error" };
      const mcp = mcpClient(server);
      await mcp("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fake-cursor", version: "0" },
      });
      await mcp("notifications/initialized", {}, true);
      await onDelta({ update: { type: "text-delta", text: "Reading the change." } });
      await call(mcp, "report_progress", { message: "Reading the change with a stand-in Cursor" });
      while (flagged("hold") && !state.cancelled) await sleep(200);
      if (state.cancelled) return { status: "cancelled" };
      if (message.includes("`finish_fixes`")) {
        const ids =
          /one entry for each of (.+), then end your turn\./.exec(message)?.[1]?.split(", ") ?? [];
        const callId = NodeCrypto.randomUUID();
        const file = NodePath.join(this.options.local.cwd, "stand-in.md");
        const toolCall = { type: "edit", args: { path: file } };
        await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
        NodeFS.writeFileSync(file, "Written by the stand-in Cursor.\n");
        await onDelta({
          update: {
            type: "tool-call-completed",
            callId,
            toolCall: { ...toolCall, result: { status: "success", value: {} } },
          },
        });
        const reported = await call(mcp, "finish_fixes", {
          summary: "Add the stand-in Cursor's note",
          perComment: ids.map((commentId) => ({
            commentId,
            status: "fixed",
            note: "The stand-in Cursor added a note.",
          })),
        });
        return { status: reported.ok ? "finished" : "error" };
      }
      const submitted = await call(mcp, "submit_guide", {
        summary: "A guide written by the stand-in Cursor.",
        chapters: [{ title: "Every change", files: changedFiles(message) }],
      });
      return { status: submitted.ok ? "finished" : "error" };
    };
    const done = work();
    return {
      wait: () => done,
      cancel: async () => {
        state.cancelled = true;
      },
    };
  }
  close() {}
}

const record = (options, resumed) => {
  if (CONTROL === "") return;
  NodeFS.appendFileSync(
    NodePath.join(CONTROL, "runs.log"),
    `${JSON.stringify({
      tools: options.tools ?? null,
      disallowedTools: options.disallowedTools ?? null,
      settingSources: options.local?.settingSources ?? null,
      sandbox: options.local?.sandboxOptions?.enabled ?? null,
      mcpServers: Object.keys(options.mcpServers ?? {}),
      cwd: options.local?.cwd ?? null,
      home: process.env.HOME ?? null,
      resumed,
    })}\n`,
  );
};

export const Agent = {
  create: async (options) => {
    checkKey(options.apiKey);
    record(options, false);
    const agentId = `agent-${NodeCrypto.randomUUID()}`;
    options.local.store.add(agentId);
    return new StandInAgent(agentId, options);
  },
  resume: async (agentId, options) => {
    checkKey(options.apiKey);
    if (!options.local.store.list().includes(agentId)) throw new Error("Agent not found");
    record(options, true);
    return new StandInAgent(agentId, options);
  },
  get: async (agentId, options) => {
    if (!options.store.list().includes(agentId)) throw new Error("Agent not found");
    return { agentId };
  },
};
