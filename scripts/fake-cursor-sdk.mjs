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
 *   many-models    Cursor lists 400 more models, more than a pipe takes at once
 *   builtin-read   a turn calls Cursor's own read tool, then still tries submit_guide
 *   disposed.log   each agent disposed, written a moment after the dispose starts, as the
 *                  SDK's own store writes land late
 *   probe.json     calls a turn makes first, `[{ "tool": "read_file", "args": {...} }]`
 *   runs.log       each turn appends what it was started with: tools, setting sources, sandbox,
 *                  MCP servers, custom tool names, cwd, HOME, HTTPS_PROXY, whether
 *                  CURSOR_API_KEY was in its environment, and whether it resumed
 *   calls.log      each custom tool call: its name, arguments, whether it worked, and its text
 *
 * Like Cursor, it offers the model only the custom tools it was given, under the
 * `custom-user-tools` server, and runs them in the host process. A guide turn reads the first
 * file the prompt lists, reports progress and submits a guide with one chapter holding every
 * file; a fix writes `stand-in.md` and reports every comment fixed. Every turn ends with half a
 * line of its own on stdout, as SDKs print. Keys are `stand-in-...`; anything else is turned down.
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
        ...(flagged("many-models")
          ? Array.from({ length: 400 }, (_, index) => ({
              id: `stand-in-extra-${index}`,
              displayName: `Stand-in extra ${index}`,
              description: "A stand-in model listed to make the list long. ".repeat(4),
            }))
          : []),
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

class StandInAgent {
  constructor(agentId, options) {
    this.agentId = agentId;
    this.options = options;
  }
  async send(message, sendOptions = {}) {
    const onDelta = sendOptions.onDelta ?? (() => {});
    const tools = sendOptions.local?.customTools ?? this.options.local?.customTools ?? {};
    const state = { cancelled: false };
    const call = async (tool, args) => {
      const callId = NodeCrypto.randomUUID();
      const toolCall = {
        type: "mcp",
        args: { providerIdentifier: "custom-user-tools", toolName: tool, args },
      };
      await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
      const found = tools[tool];
      const result =
        found === undefined
          ? { content: [{ type: "text", text: `No tool named ${tool}` }], isError: true }
          : await found.execute(args, { toolCallId: callId });
      const ok = result.isError !== true;
      const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
      if (CONTROL !== "")
        NodeFS.appendFileSync(
          NodePath.join(CONTROL, "calls.log"),
          `${JSON.stringify({ tool, args, ok, text })}\n`,
        );
      await onDelta({
        update: {
          type: "tool-call-completed",
          callId,
          // Like Cursor: a tool that returns, even with an error, completes as a success.
          toolCall: {
            ...toolCall,
            result: {
              status: "success",
              value: { content: [{ text: { text } }], isError: !ok },
            },
          },
        },
      });
      return { ok, text };
    };
    const work = async () => {
      const probe = NodePath.join(CONTROL, "probe.json");
      if (CONTROL !== "" && NodeFS.existsSync(probe))
        for (const step of JSON.parse(NodeFS.readFileSync(probe, "utf8")))
          await call(step.tool, step.args);
      await onDelta({ update: { type: "text-delta", text: "Reading the change." } });
      await call("report_progress", { message: "Reading the change with a stand-in Cursor" });
      while (flagged("hold") && !state.cancelled) await sleep(200);
      if (state.cancelled) return { status: "cancelled" };
      if (flagged("builtin-read")) {
        const callId = NodeCrypto.randomUUID();
        const toolCall = { type: "read", args: { path: "/etc/hosts" } };
        await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
        await call("submit_guide", { summary: "After a tool of Cursor's own", chapters: [] });
        return { status: state.cancelled ? "cancelled" : "finished" };
      }
      if (message.includes("`finish_fixes`")) {
        const ids =
          /one entry for each of (.+), then end your turn\./.exec(message)?.[1]?.split(", ") ?? [];
        await call("write_file", {
          path: "stand-in.md",
          content: "Written by the stand-in Cursor.\n",
        });
        const reported = await call("finish_fixes", {
          summary: "Add the stand-in Cursor's note",
          perComment: ids.map((commentId) => ({
            commentId,
            status: "fixed",
            note: "The stand-in Cursor added a note.",
          })),
        });
        return { status: reported.ok ? "finished" : "error" };
      }
      const files = changedFiles(message);
      if (files[0] !== undefined) await call("read_file", { path: files[0] });
      const submitted = await call("submit_guide", {
        summary: "A guide written by the stand-in Cursor.",
        chapters: [{ title: "Every change", files }],
      });
      return { status: submitted.ok ? "finished" : "error" };
    };
    const done = work().then((result) => {
      process.stdout.write("stand-in SDK noise without a newline ");
      return result;
    });
    return {
      wait: () => done,
      cancel: async () => {
        state.cancelled = true;
      },
    };
  }
  close() {}
  async [Symbol.asyncDispose]() {
    await sleep(300);
    if (CONTROL !== "")
      NodeFS.appendFileSync(NodePath.join(CONTROL, "disposed.log"), `${this.agentId}\n`);
  }
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
      customTools: Object.keys(options.local?.customTools ?? {}).sort(),
      cwd: options.local?.cwd ?? null,
      home: process.env.HOME ?? null,
      proxy: process.env.HTTPS_PROXY ?? null,
      keyInEnv: process.env.CURSOR_API_KEY !== undefined,
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
