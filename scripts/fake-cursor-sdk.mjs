/**
 * A stand-in for Cursor's SDK (`@cursor/sdk`), so tests can install, sign in and run Cursor
 * without Cursor. `tests/fakeCursor.ts` lays it out as an SDK package folder, and prkit loads it
 * through PRKIT_CURSOR_SDK_PATH or the installer. Plain JavaScript: the installer puts it under
 * node_modules, where Node strips no types. prkit runs it in the runner's sandbox like the real
 * SDK, which opens no test folder and no local port but prkit's, so a test steers it with files in
 * `control/` in its own package folder, which it may read, and reads what it did in `stand-in/`
 * in its HOME, the instance's home, which it may write. Each line there is JSON with an `at`.
 *
 * In control/:
 *   approve-login  a sign-in waiting in the browser finishes
 *   reject-keys    Cursor turns every key down
 *   hold           a turn keeps writing until the file is removed
 *   many-models    Cursor lists 400 more models, more than a pipe takes at once
 *   builtin-read   a turn calls Cursor's own read tool, then still tries submit_guide
 *   builtin-overlap  a turn starts submit_guide, starts Cursor's own read tool while it runs,
 *                  then lets submit_guide finish
 *   shell-output   a turn reports a shell's output, as Cursor's own shell tool would
 *   partial-call   a turn reports a call to a custom tool while it is still being written,
 *                  before its server is named, as Cursor does
 *   raw-call       a turn starts a tool of a kind the SDK doesn't name, which arrives raw
 *                  (`{ case, value }`), then still tries submit_guide
 *   escape.json    what a turn tries first with Node's own calls, past prkit's tools: `reads`
 *                  and `writes` (paths), `renames` and `links` (hard, `[from, to]` pairs),
 *                  `replaces` (`[target, path]`: removes path, then links it to target),
 *                  `children` (paths a child process reads), `sockets` (unix sockets),
 *                  `ports` (`[host, port]` TCP pairs) and `detached` (a count of processes
 *                  started in a session of their own, whose pids go to detached.log); each
 *                  outcome goes to escape.log
 *
 * In stand-in/:
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
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL = NodePath.join(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "control",
);
const flagged = (name) => NodeFS.existsSync(NodePath.join(CONTROL, name));
const controlFile = (name) => {
  const file = NodePath.join(CONTROL, name);
  return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
};
const log = (name, value) => {
  const dir = NodePath.join(process.env.HOME ?? "", "stand-in");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(dir, name),
    `${JSON.stringify({ ...value, at: performance.timeOrigin + performance.now() })}\n`,
  );
};
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

const checkKey = async (apiKey) => {
  if ((await flagged("reject-keys")) || !String(apiKey ?? "").startsWith("stand-in-"))
    throw new AuthenticationError("Invalid User API Key");
};

export const Cursor = {
  me: async ({ apiKey } = {}) => {
    await checkKey(apiKey);
    return { apiKeyName: "prkit", createdAt: new Date(0).toISOString() };
  },
  models: {
    list: async ({ apiKey } = {}) => {
      await checkKey(apiKey);
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
        ...((await flagged("many-models"))
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
      while (!(await flagged("approve-login"))) await sleep(200);
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

const NOTHING_TO_CHECK = { steps: [], reason: "The stand-in agent never suggests checks." };

const riskOf = (prompt, files) => {
  const level = prompt.includes("- Look closely:") ? "medium" : "low";
  return {
    chapter: {
      level,
      reasons: [{ text: "The stand-in Cursor rates every change alike.", file: files[0] }],
    },
    guide: { level, reasons: [{ text: "The stand-in Cursor read one chapter.", chapter: 1 }] },
  };
};

/** On the author's own pull request the guide owes a pre-flight; the stand-in has nothing to flag. */
const preflightOf = (prompt) =>
  prompt.includes("so the guide is for its own author") ? { preflight: {} } : {};

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
      await log("calls.log", { tool, args, ok, text });
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
      const escape = controlFile("escape.json");
      if (escape !== null) {
        const steps = JSON.parse(escape);
        const attempt = async (op, path, run) => {
          try {
            await run();
            log("escape.log", { op, path, ok: true, code: null });
          } catch (error) {
            log("escape.log", { op, path, ok: false, code: error.code ?? "unknown" });
          }
        };
        const connect = (options) =>
          new Promise((resolve, reject) => {
            const socket = NodeNet.connect(options, () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", reject);
            socket.setTimeout(2000, () => {
              socket.destroy();
              reject(Object.assign(new Error("timed out"), { code: "timeout" }));
            });
          });
        for (const path of steps.reads ?? [])
          await attempt("read", path, () => NodeFS.readFileSync(path));
        for (const path of steps.writes ?? [])
          await attempt("write", path, () => NodeFS.writeFileSync(path, "written past prkit\n"));
        for (const [from, to] of steps.renames ?? [])
          await attempt("rename", `${from} -> ${to}`, () => NodeFS.renameSync(from, to));
        for (const [from, to] of steps.links ?? [])
          await attempt("link", `${from} -> ${to}`, () => NodeFS.linkSync(from, to));
        for (const [target, path] of steps.replaces ?? [])
          await attempt("replace", `${path} -> ${target}`, () => {
            NodeFS.rmSync(path, { recursive: true, force: true });
            NodeFS.symlinkSync(target, path);
          });
        for (const path of steps.children ?? [])
          await attempt("child", path, () => {
            const child = NodeChildProcess.spawnSync("/bin/cat", [path], { encoding: "utf8" });
            if (child.status !== 0)
              throw Object.assign(new Error(child.stderr), {
                code: /not permitted/.test(child.stderr) ? "EPERM" : `exit ${child.status}`,
              });
          });
        for (const path of steps.sockets ?? [])
          await attempt("socket", path, () => connect({ path }));
        for (const [host, port] of steps.ports ?? [])
          await attempt("port", `${host} ${port}`, () => connect({ host, port }));
        for (let i = 0; i < (steps.detached ?? 0); i++) {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            {
              detached: true,
              stdio: "ignore",
            },
          );
          child.unref();
          log("detached.log", { pid: child.pid });
        }
      }
      const probe = controlFile("probe.json");
      if (probe !== null) for (const step of JSON.parse(probe)) await call(step.tool, step.args);
      if (await flagged("partial-call"))
        await onDelta({
          update: {
            type: "partial-tool-call",
            callId: NodeCrypto.randomUUID(),
            toolCall: { type: "mcp", args: { toolName: "report_progress" } },
          },
        });
      await onDelta({ update: { type: "text-delta", text: "Reading the change." } });
      await call("report_progress", { message: "Reading the change with a stand-in Cursor" });
      while ((await flagged("hold")) && !state.cancelled) await sleep(200);
      if (state.cancelled) return { status: "cancelled" };
      if (await flagged("shell-output")) {
        await onDelta({ update: { type: "shell-output-delta", event: { stdout: "hosts\n" } } });
        await call("submit_guide", { summary: "After a shell of Cursor's own", chapters: [] });
        return { status: state.cancelled ? "cancelled" : "finished" };
      }
      if (await flagged("builtin-overlap")) {
        const files = changedFiles(message);
        const risk = riskOf(message, files);
        const args = {
          summary: "A guide finishing while Cursor's own tool runs.",
          chapters: [{ title: "Every change", files, risk: risk.chapter }],
          risk: risk.guide,
          manualCheck: NOTHING_TO_CHECK,
          ...preflightOf(message),
        };
        const callId = NodeCrypto.randomUUID();
        const toolCall = {
          type: "mcp",
          args: { providerIdentifier: "custom-user-tools", toolName: "submit_guide", args },
        };
        await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
        const running = tools.submit_guide.execute(args, { toolCallId: callId });
        await onDelta({
          update: {
            type: "tool-call-started",
            callId: NodeCrypto.randomUUID(),
            toolCall: { type: "read", args: { path: "/etc/hosts" } },
          },
        });
        const result = await running;
        const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
        await log("calls.log", { tool: "submit_guide", args, ok: result.isError !== true, text });
        await onDelta({
          update: {
            type: "tool-call-completed",
            callId,
            toolCall: {
              ...toolCall,
              result: {
                status: "success",
                value: { content: [{ text: { text } }], isError: result.isError === true },
              },
            },
          },
        });
        return { status: "finished" };
      }
      if (flagged("raw-call")) {
        const callId = NodeCrypto.randomUUID();
        const toolCall = { case: "futureTool", value: { args: {} } };
        await onDelta({ update: { type: "tool-call-started", callId, toolCall } });
        await call("submit_guide", {
          summary: "After a tool of a kind the SDK doesn't name",
          chapters: [],
        });
        return { status: state.cancelled ? "cancelled" : "finished" };
      }
      if (await flagged("builtin-read")) {
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
      const risk = riskOf(message, files);
      const submitted = await call("submit_guide", {
        summary: "A guide written by the stand-in Cursor.",
        chapters: [{ title: "Every change", files, risk: risk.chapter }],
        risk: risk.guide,
        manualCheck: NOTHING_TO_CHECK,
        ...preflightOf(message),
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
    log("disposed.log", { agentId: this.agentId });
  }
}

const record = (options, resumed) =>
  log("runs.log", {
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
  });

export const Agent = {
  create: async (options) => {
    await checkKey(options.apiKey);
    await record(options, false);
    const agentId = `agent-${NodeCrypto.randomUUID()}`;
    options.local.store.add(agentId);
    return new StandInAgent(agentId, options);
  },
  resume: async (agentId, options) => {
    await checkKey(options.apiKey);
    if (!options.local.store.list().includes(agentId)) throw new Error("Agent not found");
    await record(options, true);
    return new StandInAgent(agentId, options);
  },
  get: async (agentId, options) => {
    if (!options.store.list().includes(agentId)) throw new Error("Agent not found");
    return { agentId };
  },
};
