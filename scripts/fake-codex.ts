/**
 * A stand-in for Codex, so a journey can write a guide without a subscription. prkit runs it
 * through PRKIT_CODEX_PATH (`verify-app start --codex <file>`); `tests/fakeCodex.ts` writes the
 * wrapper that runs this script with FAKE_CODEX_DIR set.
 *
 *   codex --version                 codex-cli 0.163.0
 *   codex [-c k=v ...] login status   signed in (exit 0)
 *   codex [-c k=v ...] logout         signed out (exit 0)
 *   codex [-c k=v ...] app-server --listen stdio://
 *       answers prkit's JSON-RPC over stdio: signed in with a ChatGPT Pro plan, `model/list`
 *       (the models a login offers), an empty config, and threads that connect to prkit's MCP
 *       server. Asked for a guide (a `turn/start` whose prompt is not a fix or a question), it
 *       reports progress and submits a guide through that server, with one chapter holding
 *       every file the prompt lists, and ends the turn. Asked for fixes, conflicts or an
 *       answer to a question (a `<prkit-ask>` prompt), it ends the turn with an error: this
 *       stand-in only writes guides. Any other request gets a JSON-RPC error.
 *
 * In FAKE_CODEX_DIR, a `models.json` file, a JSON array of `model/list` entries, replaces the
 * built-in list, which is shaped like Codex 0.163's: GPT-6.1-Sol is Codex's default, at low.
 * A `page-size` file holding a number pages `model/list` that many entries at a time, as Codex
 * does, with the index of the next page as the cursor.
 * Every turn appends `{codexHome, cwd, thread, start, model, effort, serviceTier}` to `runs.log`
 * (`start` is new, resume or fork; `model`, `effort` and `serviceTier` are what `turn/start`
 * carried, null when it carried none), and every thread it makes goes in `threads`, one id a
 * line, which is what `thread/read` knows.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const args = process.argv.slice(2);
const command = args.filter((arg, index) => arg !== "-c" && args[index - 1] !== "-c");

if (command[0] === "--version") {
  process.stdout.write("codex-cli 0.163.0\n");
  process.exit(0);
}
if (command[0] === "login" && command[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (command[0] === "logout") process.exit(0);
if (command[0] !== "app-server") {
  process.stderr.write(`fake-codex doesn't run ${command[0] ?? "without a command"}\n`);
  process.exit(2);
}

const control = process.env.FAKE_CODEX_DIR ?? "";
const write = (message: Schema.Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

type Id = string | number;
const reply = (id: Id, result: Schema.Json) => write({ id, result });
const refuse = (id: Id, code: number, message: string) => write({ id, error: { code, message } });
const notify = (method: string, params: Schema.Json) => write({ method, params });

const Line = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Json),
  }),
);
const ThreadParams = Schema.Struct({
  threadId: Schema.optionalKey(Schema.String),
  modelProvider: Schema.String,
  approvalPolicy: Schema.String,
  config: Schema.Struct({
    default_permissions: Schema.String,
    mcp_servers: Schema.Struct({
      prkit: Schema.Struct({
        url: Schema.String,
        http_headers: Schema.Record(Schema.String, Schema.String),
        enabled_tools: Schema.Array(Schema.String),
      }),
    }),
  }),
});
const ModelListParams = Schema.Struct({ cursor: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const ThreadIdParams = Schema.Struct({ threadId: Schema.String });
const TurnParams = Schema.Struct({
  threadId: Schema.String,
  cwd: Schema.String,
  input: Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const McpReply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optionalKey(
      Schema.Struct({
        isError: Schema.optionalKey(Schema.Boolean),
        content: Schema.optionalKey(
          Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
        ),
      }),
    ),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);
const Models = Schema.fromJsonString(Schema.Array(Schema.Json));

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const listed = (
  slug: string,
  displayName: string,
  defaultReasoningEffort: string,
  options: { readonly isDefault?: boolean; readonly ultra?: boolean; readonly fast?: boolean } = {},
): Schema.Json => ({
  id: slug,
  model: slug,
  displayName,
  description: `${displayName}, as the stand-in lists it.`,
  hidden: false,
  isDefault: options.isDefault === true,
  supportedReasoningEfforts: EFFORTS.filter(
    (effort) => options.ultra !== false || effort !== "ultra",
  ).map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })),
  defaultReasoningEffort,
  serviceTiers:
    options.fast === true
      ? [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }]
      : [],
  defaultServiceTier: null,
});
const BUILT_IN_MODELS: ReadonlyArray<Schema.Json> = [
  listed("gpt-6.1-sol", "GPT-6.1-Sol", "low", { isDefault: true, fast: true }),
  listed("gpt-6-astra", "GPT-6-Astra", "medium"),
  listed("gpt-6-sol", "GPT-6-Sol", "medium"),
  listed("gpt-6-luna", "GPT-6-Luna", "medium", { ultra: false }),
  listed("gpt-5.6-sol", "GPT-5.6-Sol", "low"),
  listed("gpt-5.6-terra", "GPT-5.6-Terra", "medium"),
  listed("gpt-5.6-luna", "GPT-5.6-Luna", "medium"),
];
const modelList = () => {
  const file = NodePath.join(control, "models.json");
  return control !== "" && NodeFS.existsSync(file)
    ? Schema.decodeUnknownSync(Models)(NodeFS.readFileSync(file, "utf8"))
    : BUILT_IN_MODELS;
};
const modelPage = (cursor: string | null | undefined) => {
  const all = modelList();
  const file = NodePath.join(control, "page-size");
  const size =
    control !== "" && NodeFS.existsSync(file) ? Number(NodeFS.readFileSync(file, "utf8")) : 0;
  if (!(size > 0)) return { data: [...all], nextCursor: null };
  const from = Number(cursor ?? 0);
  const next = from + size;
  return { data: all.slice(from, next), nextCursor: next < all.length ? String(next) : null };
};

type Start = "new" | "resume" | "fork";
type Thread = {
  readonly start: Start;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly tools: ReadonlyArray<string>;
};
const threads = new Map<string, Thread>();

const mcpClient = (url: string, headers: Readonly<Record<string, string>>) => {
  let session: string | null = null;
  let nextId = 1;
  return async (method: string, params: Schema.Json, notification = false) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
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
    if (notification) return { ok: response.ok, text, said: "" };
    const body = text.includes("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    const parsed = Schema.decodeOption(McpReply)(body);
    const ok =
      response.ok &&
      Option.isSome(parsed) &&
      parsed.value.error === undefined &&
      parsed.value.result?.isError !== true;
    const said = Option.match(parsed, {
      onNone: () => body,
      onSome: (value) =>
        value.error?.message ??
        (value.result?.content ?? [])
          .flatMap((part) => (part.text === undefined ? [] : [part.text]))
          .join("\n"),
    });
    return { ok, text: body, said };
  };
};

const changedFiles = (prompt: string) => {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^Changed files \(\d+\):$/.test(line));
  return lines.slice(start + 1).flatMap((line) => {
    const match = /^- (?:added|modified|removed|renamed) (?:.+ -> )?(.+?) \(\+\d+ -\d+/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
};

const riskOf = (prompt: string) => {
  const level = prompt.includes("- Look closely:") ? "medium" : "low";
  return {
    chapter: (paths: ReadonlyArray<string>) => ({
      level,
      reasons: [{ text: "The stand-in agent rates every change alike.", file: paths[0] ?? "" }],
    }),
    guide: { level, reasons: [{ text: "The stand-in agent read the first chapter.", chapter: 1 }] },
  };
};

const completed = (threadId: string, turnId: string, error: string | null) =>
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: error === null ? "completed" : "failed",
      error: error === null ? null : { message: error },
    },
  });

const guide = async (threadId: string, turnId: string, thread: Thread, prompt: string) => {
  const call = mcpClient(thread.url, thread.headers);
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-codex", version: "0" },
  });
  await call("notifications/initialized", {}, true);
  await call("tools/call", {
    name: "report_progress",
    arguments: { message: "Reading the change with a stand-in agent" },
  });
  const files = changedFiles(prompt);
  const risk = riskOf(prompt);
  const itemId = NodeCrypto.randomUUID();
  notify("item/started", {
    threadId,
    item: { type: "mcpToolCall", id: itemId, server: "prkit", tool: "submit_guide" },
  });
  const submitted = await call("tools/call", {
    name: "submit_guide",
    arguments: {
      summary: "A guide written by the stand-in agent.",
      chapters:
        files.length === 0 ? [] : [{ title: "Every change", files, risk: risk.chapter(files) }],
      risk: risk.guide,
      manualCheck: { steps: [], reason: "The stand-in agent never suggests checks." },
      focusAreas: [...prompt.matchAll(/^- `([^`]+)` .+: .+$/gm)].map((match) => ({
        id: match[1] ?? "",
        verdict: "nothing-notable",
      })),
      ...(prompt.includes("so the guide is for its own author") ? { preflight: {} } : {}),
    },
  });
  notify("item/completed", {
    threadId,
    item: {
      id: itemId,
      type: "mcpToolCall",
      status: submitted.ok ? "completed" : "failed",
      ...(submitted.ok ? {} : { error: { message: submitted.said.slice(0, 300) } }),
    },
  });
  return completed(
    threadId,
    turnId,
    submitted.ok ? null : `submit_guide was refused: ${submitted.said.slice(0, 300)}`,
  );
};

const record = (turn: typeof TurnParams.Type, start: Start) => {
  if (control === "") return;
  NodeFS.appendFileSync(
    NodePath.join(control, "runs.log"),
    `${JSON.stringify({
      codexHome: process.env.CODEX_HOME ?? null,
      cwd: turn.cwd,
      thread: turn.threadId,
      start,
      model: turn.model ?? null,
      effort: turn.effort ?? null,
      serviceTier: turn.serviceTier ?? null,
    })}\n`,
  );
};

const remember = (id: string) => {
  if (control !== "") NodeFS.appendFileSync(NodePath.join(control, "threads"), `${id}\n`);
};
const knows = (id: string) =>
  control !== "" &&
  NodeFS.existsSync(NodePath.join(control, "threads")) &&
  NodeFS.readFileSync(NodePath.join(control, "threads"), "utf8").split("\n").includes(id);

const openThread = (id: Id, params: Schema.Json, start: Start) =>
  Option.match(Schema.decodeUnknownOption(ThreadParams)(params), {
    onNone: () => refuse(id, -32602, `fake-codex couldn't read the ${start} thread's settings`),
    onSome: (settings) => {
      const prkit = settings.config.mcp_servers.prkit;
      const threadId =
        start === "resume"
          ? (settings.threadId ?? NodeCrypto.randomUUID())
          : NodeCrypto.randomUUID();
      if (start !== "resume") remember(threadId);
      threads.set(threadId, {
        start,
        url: prkit.url,
        headers: prkit.http_headers,
        tools: prkit.enabled_tools,
      });
      reply(id, {
        thread: { id: threadId },
        modelProvider: settings.modelProvider,
        approvalPolicy: settings.approvalPolicy,
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: { id: settings.config.default_permissions },
        instructionSources: [],
      });
    },
  });

const startTurn = (id: Id, params: Schema.Json) =>
  Option.match(Schema.decodeUnknownOption(TurnParams)(params), {
    onNone: () => refuse(id, -32602, "fake-codex couldn't read turn/start's settings"),
    onSome: (turn) => {
      const thread = threads.get(turn.threadId);
      if (thread === undefined)
        return refuse(id, -32602, `fake-codex has no thread ${turn.threadId}`);
      record(turn, thread.start);
      const turnId = NodeCrypto.randomUUID();
      reply(id, { turn: { id: turnId } });
      const prompt = turn.input.map((part) => part.text ?? "").join("\n");
      if (
        prompt.includes("`finish_fixes`") ||
        prompt.includes("`finish_conflicts`") ||
        /^<prkit-ask>$/m.test(prompt)
      )
        return completed(turn.threadId, turnId, "The Codex stand-in only writes guides.");
      void guide(turn.threadId, turnId, thread, prompt);
    },
  });

const handle = (id: Id, method: string, params: Schema.Json) => {
  switch (method) {
    case "initialize":
      return reply(id, { userAgent: "fake-codex/0.163.0" });
    case "account/read":
      return reply(id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true });
    case "model/list":
      return reply(
        id,
        modelPage(Option.getOrNull(Schema.decodeUnknownOption(ModelListParams)(params))?.cursor),
      );
    case "config/read":
      return reply(id, { config: {} });
    case "thread/start":
      return openThread(id, params, "new");
    case "thread/resume":
      return openThread(id, params, "resume");
    case "thread/fork":
      return openThread(id, params, "fork");
    case "thread/read":
      return Option.match(Schema.decodeUnknownOption(ThreadIdParams)(params), {
        onNone: () => refuse(id, -32602, "fake-codex couldn't read thread/read's settings"),
        onSome: ({ threadId }) =>
          knows(threadId)
            ? reply(id, { thread: { id: threadId } })
            : refuse(id, -32600, `fake-codex has no thread ${threadId}`),
      });
    case "mcpServerStatus/list":
      return Option.match(Schema.decodeUnknownOption(ThreadIdParams)(params), {
        onNone: () =>
          refuse(id, -32602, "fake-codex couldn't read mcpServerStatus/list's settings"),
        onSome: ({ threadId }) =>
          reply(id, {
            data: [
              {
                name: "prkit",
                runtimeStatus: "connected",
                tools: Object.fromEntries(
                  (threads.get(threadId)?.tools ?? []).map((name) => [name, { name }]),
                ),
                toolsError: null,
              },
            ],
          }),
      });
    case "turn/start":
      return startTurn(id, params);
    default:
      return refuse(id, -32601, `fake-codex doesn't answer ${method}`);
  }
};

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (text) => {
  const line = Schema.decodeOption(Line)(text);
  if (Option.isNone(line) || line.value.id === undefined) return;
  handle(line.value.id, line.value.method, line.value.params ?? null);
});
lines.on("close", () => process.exit(0));
