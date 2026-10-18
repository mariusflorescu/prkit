// @effect-diagnostics-next-line nodeBuiltinImport:off -- runs the runner itself, to read its exit code
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stand-in for prkit's MCP server, outside Effect
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentInstanceId } from "@prkit/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { build } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import {
  type AgentEvent,
  type AgentProvider,
  FIX_TOOLS,
  GUIDE_TOOLS,
  PRKIT_TOOLS,
  type TurnInput,
} from "../AgentProvider.ts";
import { checkoutFor } from "../../repo/gitRun.ts";
import * as CursorAgent from "./CursorAgent.ts";
import { Event, eventMark, eventText, FORBIDDEN } from "./protocol.ts";
import { SDK_PATH_VARIABLE } from "./sdkLoader.ts";
import { ALLOWED_TOOLS, DENIED_TOOLS } from "./tools.ts";

const Run = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.NullOr(Schema.Array(Schema.String)),
    disallowedTools: Schema.NullOr(Schema.Array(Schema.String)),
    settingSources: Schema.NullOr(Schema.Array(Schema.String)),
    sandbox: Schema.NullOr(Schema.Boolean),
    mcpServers: Schema.Array(Schema.String),
    customTools: Schema.Array(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    home: Schema.NullOr(Schema.String),
    proxy: Schema.NullOr(Schema.String),
    keyInEnv: Schema.Boolean,
    resumed: Schema.Boolean,
  }),
);

let root = "";
let home = "";
let control = "";
let mcpUrl = "";
let runner = "";
/** Each MCP call prkit's stand-in server got: its method and tool, and whether it had the token. */
const mcpCalls: Array<{
  readonly method: string;
  readonly tool: string | null;
  readonly auth: boolean;
}> = [];
const TOKEN = "turn-token-123";
const mcpServer = NodeHttp.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    const parsed = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          id: Schema.optionalKey(Schema.Number),
          method: Schema.String,
          params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
        }),
      ),
    )(body);
    mcpCalls.push({
      method: parsed.method,
      tool: parsed.params?.name ?? null,
      auth: request.headers.authorization === `Bearer ${TOKEN}`,
    });
    if (parsed.id === undefined) return response.writeHead(202).end();
    const result =
      parsed.method === "tools/list"
        ? { tools: PRKIT_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) }
        : { content: [], isError: false };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
  });
});

const fsRun = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

beforeAll(async () => {
  root = await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ prefix: "prkit-cursor-" });
    }),
  );
  home = `${root}/prkit-home`;
  // The runner bundled like the app's: from source, each start loads about 180 modules and takes
  // two to three times as long, which put six starts in a row past 5 s on a busy machine.
  runner = `${root}/runner/cursorRunner.mjs`;
  await build({
    configFile: false,
    logLevel: "silent",
    root: new URL("../../..", import.meta.url).pathname,
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: "src/agents/cursor/runner.ts",
      outDir: `${root}/runner`,
      minify: false,
      rollupOptions: { output: { entryFileNames: "cursorRunner.mjs" } },
    },
  });
  // The stand-in SDK as a package folder, steered from `control` in it.
  control = `${root}/sdk/control`;
  const source = await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(
        new URL("../../../../../scripts/fake-cursor-sdk.mjs", import.meta.url).pathname,
      );
    }),
  );
  await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/sdk/dist/esm`, { recursive: true });
      yield* fs.makeDirectory(control, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(`${root}/sdk/package.json`, '{"type":"module"}\n');
      yield* fs.writeFileString(`${root}/sdk/dist/esm/index.js`, source);
    }),
  );
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const address = mcpServer.address();
  mcpUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/mcp`;
});
afterAll(async () => {
  delete process.env[SDK_PATH_VARIABLE];
  await new Promise((resolve) => mcpServer.close(resolve));
  await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(root, { recursive: true });
    }),
  );
});

const Config = Layer.sync(ServerConfig.ServerConfig, () =>
  ServerConfig.ServerConfig.of({
    host: ServerConfig.SERVER_HOST,
    port: 0,
    home,
    dbPath: ":memory:",
    webDist: Option.none(),
    devWebOrigin: Option.none(),
    authToken: Redacted.make("test"),
    watchIntervalMs: 60_000,
    devReviewRequested: [],
    version: "0.0.0",
    startedAt: "2026-10-15T00:00:00.000Z",
  }),
);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | ServerConfig.ServerConfig
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(Config, NodeServices.layer)),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

const setupOf = (id: string, env: Record<string, string> = {}) => ({
  id: AgentInstanceId.make(id),
  label: id,
  isDefault: id === "cursor",
  configDir: null,
  binaryPath: null,
  environment: env,
  login: "shared" as const,
});

/** An instance on the stand-in SDK, or on none when `installed` is false. */
const instance = (
  id: string,
  options: { readonly installed?: boolean; readonly env?: Record<string, string> } = {},
) => {
  if (options.installed === false) delete process.env[SDK_PATH_VARIABLE];
  else {
    process.env.PRKIT_E2E = "1";
    process.env[SDK_PATH_VARIABLE] = `${root}/sdk`;
  }
  return run(CursorAgent.make(setupOf(id, options.env), runner));
};

const flag = (name: string, on: boolean) =>
  fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (on) yield* fs.writeFileString(`${control}/${name}`, "");
      else yield* fs.remove(`${control}/${name}`, { force: true });
    }),
  );

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const Detached = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const Disposed = Schema.fromJsonString(Schema.Struct({ agentId: Schema.String }));
const At = Schema.fromJsonString(Schema.Struct({ at: Schema.Number }));

/** Every line the stand-in logged as `name`, in every instance's home, oldest first. */
const standIn = async (name: string) => {
  const lines = await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instances = `${home}/cursor-instances`;
      if (!(yield* fs.exists(instances))) return [];
      const found: Array<string> = [];
      for (const id of yield* fs.readDirectory(instances)) {
        const file = `${instances}/${id}/home/stand-in/${name}`;
        if (yield* fs.exists(file)) found.push(...(yield* fs.readFileString(file)).split("\n"));
      }
      return found;
    }),
  );
  return lines
    .filter((line) => line !== "")
    .map((line) => ({ at: Schema.decodeUnknownSync(At)(line).at, line }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.line);
};

/** Forgets what the stand-in logged as `name`, in every instance's home. */
const forget = (name: string) =>
  fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instances = `${home}/cursor-instances`;
      if (!(yield* fs.exists(instances))) return;
      for (const id of yield* fs.readDirectory(instances))
        yield* fs.remove(`${instances}/${id}/home/stand-in/${name}`, { force: true });
    }),
  );

const runs = async () =>
  (await standIn("runs.log")).map((line) => Schema.decodeUnknownSync(Run)(line));

const Escape = Schema.fromJsonString(
  Schema.Struct({
    op: Schema.String,
    path: Schema.String,
    ok: Schema.Boolean,
    code: Schema.NullOr(Schema.String),
  }),
);

/**
 * What the stand-in's next turns try with Node's own calls before anything else, past prkit's
 * tools (fake-cursor-sdk.mjs, escape.json). Returns each outcome, as `<op> <path>: ok` or
 * `<op> <path>: <code>`.
 */
const escapeTurn = async <A>(
  steps: {
    readonly reads?: ReadonlyArray<string>;
    readonly writes?: ReadonlyArray<string>;
    readonly renames?: ReadonlyArray<readonly [string, string]>;
    readonly links?: ReadonlyArray<readonly [string, string]>;
    readonly replaces?: ReadonlyArray<readonly [string, string]>;
    readonly children?: ReadonlyArray<string>;
    readonly sockets?: ReadonlyArray<string>;
    readonly ports?: ReadonlyArray<readonly [string, number]>;
    readonly detached?: number;
  },
  turn: () => Promise<A>,
) => {
  await forget("escape.log");
  await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${control}/escape.json`, JSON.stringify(steps));
    }),
  );
  await turn();
  await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${control}/escape.json`);
    }),
  );
  return (await standIn("escape.log"))
    .map((line) => Schema.decodeUnknownSync(Escape)(line))
    .map((entry) => `${entry.op} ${entry.path}: ${entry.ok ? "ok" : entry.code}`);
};

/** Files the runner must never reach: a stand-in for the user's home, and prkit's own data. */
const privateFiles = () =>
  fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/user-home/.ssh`, { recursive: true });
      yield* fs.writeFileString(`${root}/user-home/.ssh/id_marker`, "MARKER\n");
      yield* fs.writeFileString(`${home}/agent-secrets.json`, "{}\n");
      yield* fs.makeDirectory(`${home}/cursor-instances/other/home`, { recursive: true });
      yield* fs.writeFileString(`${home}/cursor-instances/other/home/auth.json`, "{}\n");
      return [
        `${root}/user-home/.ssh/id_marker`,
        `${home}/agent-secrets.json`,
        `${home}/cursor-instances/other/home/auth.json`,
      ];
    }),
  );

const signIn = async (provider: AgentProvider) => {
  if (provider.ownLogin === null) throw new Error("Cursor has its own sign-in");
  const login = provider.ownLogin.signIn;
  const pages: Array<string> = [];
  const done = Effect.runPromise(
    login.pipe(
      Stream.runForEach((page) =>
        Effect.promise(async () => {
          pages.push(page.url);
          await flag("approve-login", true);
        }),
      ),
    ),
  );
  await done;
  await flag("approve-login", false);
  return pages;
};

/** A checkout for one turn, with prkit's MCP server and `access`. */
const turnInput = async (
  name: string,
  access: TurnInput["access"],
  resume: string | null = null,
) => {
  const cwd = `${root}/checkouts/${name}`;
  const checkout = await fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${cwd}/src`, { recursive: true });
      yield* fs.makeDirectory(`${root}/diffs/${name}`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/src/a.js`, "export {};\n");
      return checkoutFor(yield* Path.Path, `${root}/repos/widgets.git`, cwd);
    }),
  );
  const input: TurnInput = {
    turn: { id: `turn-${name}`, ended: () => Effect.void },
    cwd,
    checkout,
    readableDirs: [`${root}/diffs/${name}`],
    instructions: "Write a guide.",
    prompt: "Changed files (1):\n- modified src/a.js (+1 -0)\n",
    resumeSessionId: resume,
    model: null,
    options: [],
    mcp: { url: mcpUrl, bearerToken: TOKEN },
    env: {},
    access,
    tools: access._tag === "write" ? FIX_TOOLS : GUIDE_TOOLS,
  };
  return input;
};

const events = (provider: AgentProvider, input: TurnInput) =>
  Effect.runPromise(
    provider.runTurn(input).pipe(
      Stream.runCollect,
      Effect.map((all): ReadonlyArray<AgentEvent> => [...all]),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

describe("Cursor's status", () => {
  it("says Cursor support isn't installed until its SDK is there", async () => {
    const provider = await instance("cursor", { installed: false });
    expect(await Effect.runPromise(provider.check)).toMatchObject({
      _tag: "unavailable",
      reason: "not-installed",
    });
    expect(await Effect.runPromise(provider.version)).toBeNull();
  });

  it("loads an SDK from PRKIT_CURSOR_SDK_PATH only in e2e", async () => {
    await instance("cursor");
    delete process.env.PRKIT_E2E;
    const outside = await run(CursorAgent.make(setupOf("cursor"), runner));
    expect(await Effect.runPromise(outside.check)).toMatchObject({ reason: "not-installed" });
  });

  it("is signed out, then signed in for prkit through the browser, then turned down", async () => {
    const provider = await instance("cursor");
    expect(await Effect.runPromise(provider.check)).toMatchObject({
      _tag: "unavailable",
      reason: "logged-out",
      ownLogin: false,
    });
    expect(await signIn(provider)).toEqual(["http://127.0.0.1:9/cursor-stand-in-login"]);
    expect(await Effect.runPromise(provider.check)).toEqual({
      _tag: "ready",
      detail: "Signed in for prkit, key good for 90 more days",
      ownLogin: true,
    });
    await flag("reject-keys", true);
    expect(await Effect.runPromise(provider.check)).toMatchObject({
      _tag: "unavailable",
      reason: "logged-out",
      ownLogin: true,
    });
    await flag("reject-keys", false);
    if (provider.ownLogin === null) throw new Error("Cursor has its own sign-in");
    await Effect.runPromise(provider.ownLogin.signOut);
    expect(await Effect.runPromise(provider.check)).toMatchObject({ reason: "logged-out" });
  });

  it("runs on an instance's own CURSOR_API_KEY, and lists Cursor's models", async () => {
    const provider = await instance("cursor_key", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const state = await Effect.runPromise(provider.check);
    expect(state).toEqual({ _tag: "ready", detail: "Your Cursor API key", ownLogin: false });
    const models = await Effect.runPromise(provider.models(state));
    expect(models.map((model) => [model.slug, model.isDefault])).toEqual([
      ["auto", true],
      ["stand-in-1", false],
    ]);
    // A list longer than a pipe takes at once still arrives whole.
    await flag("many-models", true);
    const many = await Effect.runPromise(provider.models(state));
    await flag("many-models", false);
    expect(many).toHaveLength(402);
    expect(models[1]?.options).toEqual([
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  });
});

describe("Cursor turns", () => {
  it("writes a guide with prkit's reading tools and MCP tools only, and no settings", async () => {
    const provider = await instance("cursor_guide", { env: { CURSOR_API_KEY: "stand-in-key" } });
    mcpCalls.length = 0;
    const before = (await runs()).length;
    const input = await turnInput("guide", { _tag: "read-only", tmpDir: `${root}/tmp-guide` });
    const all = await events(provider, input);
    expect(all.map((event) => event._tag)).toEqual([
      "process",
      "session",
      "text",
      "tool-done",
      "tool",
      "tool-done",
      "composing-guide",
      "tool",
      "tool-done",
      "finished",
    ]);
    expect(all.filter((event) => event._tag === "tool").map((event) => event.label)).toEqual([
      "Read src/a.js",
      "Submitted the guide",
    ]);
    expect(all.at(-1)).toEqual({ _tag: "finished", outcome: "completed", message: null });
    const [started] = (await runs()).slice(before);
    expect(started?.tools).toEqual(ALLOWED_TOOLS);
    expect(started?.disallowedTools).toEqual(DENIED_TOOLS);
    expect(started?.mcpServers).toEqual([]);
    expect(started?.customTools).toEqual(
      [...GUIDE_TOOLS, "glob", "grep", "list_dir", "read_file"].sort(),
    );
    expect(started?.settingSources).toEqual([]);
    expect(started?.sandbox).toBe(true);
    expect(started?.home).toBe(`${home}/cursor-instances/cursor_guide/home`);
    expect(
      mcpCalls.filter((call) => call.method === "tools/call").map((call) => call.tool),
    ).toEqual(["report_progress", "submit_guide"]);
    expect(mcpCalls.every((call) => call.auth)).toBe(true);

    // The next turn resumes the conversation.
    const session = all.find((event) => event._tag === "session");
    const sessionId = session?._tag === "session" ? session.sessionId : "";
    expect(await Effect.runPromise(provider.hasSession(sessionId, input.cwd))).toBe(true);
    expect(await Effect.runPromise(provider.hasSession("agent-unknown", input.cwd))).toBe(false);
    await events(provider, await turnInput("guide", input.access, sessionId));
    const [, resumed] = (await runs()).slice(before);
    expect(resumed?.resumed).toBe(true);
  });

  it("edits files in a fix through prkit's tools, and never offers a command", async () => {
    // The instance's own variables reach the runner, all but its key, which goes on stdin.
    const provider = await instance("cursor_fix", {
      env: { CURSOR_API_KEY: "stand-in-key", HTTPS_PROXY: "http://proxy.test:8080" },
    });
    const before = (await runs()).length;
    const input = await turnInput("fix", {
      _tag: "write",
      scripts: { _tag: "blocked", reason: "Cursor runs no commands" },
      tmpDir: `${root}/tmp-fix`,
    });
    const all = await events(provider, {
      ...input,
      prompt: "Call `finish_fixes` with one entry for each of c1, then end your turn.",
    });
    expect(all.filter((event) => event._tag === "tool").map((event) => event.label)).toEqual([
      "Edited stand-in.md",
      "Reported the fixes",
    ]);
    const written = await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(`${input.cwd}/stand-in.md`);
      }),
    );
    expect(written).toBe("Written by the stand-in Cursor.\n");
    const [started] = (await runs()).slice(before);
    expect(started?.tools).toEqual(ALLOWED_TOOLS);
    expect(started?.proxy).toBe("http://proxy.test:8080");
    expect(started?.keyInEnv).toBe(false);
    expect(started?.customTools).toEqual(
      [...FIX_TOOLS, "edit_file", "glob", "grep", "list_dir", "read_file", "write_file"].sort(),
    );
  });

  it("refuses a checkout with its own .cursor/sandbox.json, before Cursor starts", async () => {
    const provider = await instance("cursor_refuse", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const input = await turnInput("refused", { _tag: "read-only", tmpDir: `${root}/tmp-refused` });
    await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${input.cwd}/.cursor`);
        yield* fs.writeFileString(`${input.cwd}/.cursor/sandbox.json`, '{"type":"insecure_none"}');
      }),
    );
    const before = (await runs()).length;
    const exit = await Effect.runPromiseExit(provider.runTurn(input).pipe(Stream.runCollect));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(".cursor/sandbox.json");
    expect((await runs()).length).toBe(before);
    // A resumed turn is checked as well.
    const resumed = await Effect.runPromiseExit(
      provider.runTurn({ ...input, resumeSessionId: "agent-1" }).pipe(Stream.runCollect),
    );
    expect(Exit.isFailure(resumed)).toBe(true);
  });

  it("fails the turn when Cursor runs one of its own tools, and keeps nothing from it", async () => {
    const provider = await instance("cursor_builtin", { env: { CURSOR_API_KEY: "stand-in-key" } });
    mcpCalls.length = 0;
    await flag("builtin-read", true);
    const input = await turnInput("builtin", { _tag: "read-only", tmpDir: `${root}/tmp-builtin` });
    const exit = await Effect.runPromiseExit(
      provider
        .runTurn(input)
        .pipe(Stream.runCollect, Effect.provideService(References.MinimumLogLevel, "Error")),
    );
    await flag("builtin-read", false);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "Cursor tried to use one of its own tools, which prkit doesn't allow. Nothing from this run was kept.",
    );
    // prkit's tools refused every call after it: the guide never reached prkit.
    expect(
      mcpCalls.filter((call) => call.method === "tools/call").map((call) => call.tool),
    ).toEqual(["report_progress"]);
    // prkit's own tools alone still finish a turn.
    const ok = await events(provider, await turnInput("builtin-ok", input.access));
    expect(ok.at(-1)).toEqual({ _tag: "finished", outcome: "completed", message: null });
  });

  it("fails the turn when Cursor's own tool starts while submit_guide runs", async () => {
    const provider = await instance("cursor_overlap", { env: { CURSOR_API_KEY: "stand-in-key" } });
    await flag("builtin-overlap", true);
    const input = await turnInput("overlap", { _tag: "read-only", tmpDir: `${root}/tmp-overlap` });
    const seen: Array<AgentEvent> = [];
    const exit = await Effect.runPromiseExit(
      provider.runTurn(input).pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.provideService(References.MinimumLogLevel, "Error"),
      ),
    );
    await flag("builtin-overlap", false);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "Cursor tried to use one of its own tools",
    );
    // submit_guide's call was seen, but never as done: a review keeps a guide only after that.
    expect(
      seen.some((event) => event._tag === "tool" && event.label === "Submitted the guide"),
    ).toBe(true);
    expect(seen.filter((event) => event._tag === "tool-done" && event.ok)).toHaveLength(1);
    expect(seen.at(-1)?._tag).not.toBe("tool-done");
  });

  it("fails the turn when Cursor reports a shell's output", async () => {
    const provider = await instance("cursor_shell", { env: { CURSOR_API_KEY: "stand-in-key" } });
    mcpCalls.length = 0;
    await flag("shell-output", true);
    const input = await turnInput("shell", { _tag: "read-only", tmpDir: `${root}/tmp-shell` });
    const exit = await Effect.runPromiseExit(
      provider
        .runTurn(input)
        .pipe(Stream.runCollect, Effect.provideService(References.MinimumLogLevel, "Error")),
    );
    await flag("shell-output", false);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "Cursor tried to use one of its own tools",
    );
    expect(
      mcpCalls.filter((call) => call.method === "tools/call").map((call) => call.tool),
    ).toEqual(["report_progress"]);
  });

  it("doesn't take a custom tool call still being written for one of Cursor's own", async () => {
    const provider = await instance("cursor_partial", { env: { CURSOR_API_KEY: "stand-in-key" } });
    await flag("partial-call", true);
    const all = await events(
      provider,
      await turnInput("partial", { _tag: "read-only", tmpDir: `${root}/tmp-partial` }),
    );
    await flag("partial-call", false);
    expect(all.at(-1)).toEqual({ _tag: "finished", outcome: "completed", message: null });
  });

  it("exits non-zero when Cursor ran one of its own tools", async () => {
    await flag("builtin-read", true);
    const { code } = await runRunner("exit");
    await flag("builtin-read", false);
    expect(code).toBe(1);
  });

  it("reports a tool of a kind the SDK doesn't name, and prkit refuses the turn", async () => {
    await flag("raw-call", true);
    const { code, stdout } = await runRunner("raw");
    const provider = await instance("cursor_raw", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const exit = await Effect.runPromiseExit(
      provider
        .runTurn(await turnInput("raw-turn", { _tag: "read-only", tmpDir: `${root}/tmp-raw` }))
        .pipe(Stream.runCollect, Effect.provideService(References.MinimumLogLevel, "Error")),
    );
    await flag("raw-call", false);
    expect(code).toBe(1);
    const mark = eventMark("n");
    const tools = stdout
      .split("\n")
      .flatMap((line) => {
        const text = eventText(line, mark);
        return text === null ? [] : [decodeEvent(text)];
      })
      .filter((event) => event.type === "tool" && event.tool === "other");
    expect(tools).toMatchObject([{ name: "unknown" }]);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(FORBIDDEN);
  });

  it("hears a turn end only once Cursor saved it, through the SDK's own stray output", async () => {
    const provider = await instance("cursor_dispose", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const all = await events(
      provider,
      await turnInput("dispose", { _tag: "read-only", tmpDir: `${root}/tmp-dispose` }),
    );
    // The stand-in prints half a line before the runner's last event; the event still arrives.
    expect(all.at(-1)).toEqual({ _tag: "finished", outcome: "completed", message: null });
    const session = all.find((event) => event._tag === "session");
    const disposed = (await standIn("disposed.log")).map(
      (line) => Schema.decodeUnknownSync(Disposed)(line).agentId,
    );
    expect(disposed).toContain(session?._tag === "session" ? session.sessionId : "");
  });

  it("stops the runner's whole process group when the turn is stopped", async () => {
    const provider = await instance("cursor_stop", { env: { CURSOR_API_KEY: "stand-in-key" } });
    await flag("hold", true);
    const input = await turnInput("stop", { _tag: "read-only", tmpDir: `${root}/tmp-stop` });
    const started = await Effect.runPromise(Deferred.make<number>());
    const fiber = Effect.runFork(
      provider
        .runTurn(input)
        .pipe(
          Stream.runForEach((event) =>
            event._tag === "process" ? Deferred.succeed(started, event.pid) : Effect.void,
          ),
        ),
    );
    const pid = await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await flag("hold", false);
    const alive = (target: number) => {
      try {
        process.kill(-target, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(pid)).toBe(false);
  });
});

/** Runs the runner itself on a guide turn in a checkout of `name`: its exit code and stdout. */
const runRunner = async (name: string) => {
  const input = await turnInput(name, { _tag: "read-only", tmpDir: `${root}/tmp-${name}` });
  return new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [new URL("./runner.ts", import.meta.url).pathname],
      { cwd: input.cwd, env: { PATH: process.env.PATH, HOME: `${root}/${name}-home` } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(
      `${JSON.stringify({
        op: "turn",
        nonce: "n",
        sdk: `${root}/sdk`,
        apiKey: "stand-in-key",
        cwd: input.cwd,
        readableDirs: [],
        message: input.prompt,
        resumeSessionId: null,
        model: null,
        params: [],
        fileTools: ["read_file"],
        mcp: { url: mcpUrl, token: TOKEN, tools: [...GUIDE_TOOLS] },
      })}\n`,
    );
  });
};

describe("Cursor's sandbox", () => {
  it("keeps a guide's runner to reading its checkout, even through Node's own fs", async () => {
    // A proxy's CA file is the one file outside an instance variable opens.
    const ca = `${root}/proxy-ca/ca.pem`;
    await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${root}/proxy-ca`, { recursive: true });
        yield* fs.writeFileString(ca, "not a real certificate\n");
        yield* fs.writeFileString(`${root}/proxy-ca/other.pem`, "beside it\n");
      }),
    );
    const provider = await instance("cursor_box", {
      env: { CURSOR_API_KEY: "stand-in-key", NODE_EXTRA_CA_CERTS: ca },
    });
    const outside = await privateFiles();
    const tmpDir = `${root}/tmp-box`;
    const input = await turnInput("box", { _tag: "read-only", tmpDir });
    await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });
        // A link the pull request brings, pointing out of the checkout.
        yield* fs.symlink(outside[0] ?? "", `${input.cwd}/src/key.pem`);
      }),
    );
    const outcomes = await escapeTurn(
      {
        reads: [
          `${input.cwd}/src/a.js`,
          ca,
          `${root}/proxy-ca/other.pem`,
          `${input.cwd}/src/key.pem`,
          ...outside,
        ],
        writes: [`${input.cwd}/src/a.js`, `${root}/written-outside.txt`, `${tmpDir}/scratch.txt`],
        // A program the runner starts runs in its sandbox too.
        children: [`${input.cwd}/src/a.js`, outside[0] ?? ""],
      },
      () => events(provider, input),
    );
    expect(outcomes).toEqual([
      `read ${input.cwd}/src/a.js: ok`,
      `read ${ca}: ok`,
      `read ${root}/proxy-ca/other.pem: EPERM`,
      `read ${input.cwd}/src/key.pem: EPERM`,
      ...outside.map((file) => `read ${file}: EPERM`),
      `write ${input.cwd}/src/a.js: EPERM`,
      `write ${root}/written-outside.txt: EPERM`,
      `write ${tmpDir}/scratch.txt: ok`,
      `child ${input.cwd}/src/a.js: ok`,
      `child ${outside[0]}: EPERM`,
    ]);
  });

  it("keeps local sockets, other local ports and the saved key closed to a turn", async () => {
    const provider = await instance("cursor_boxnet", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const tmpDir = `${root}/tmp-boxnet`;
    const input = await turnInput("boxnet", { _tag: "read-only", tmpDir });
    const own = `${home}/cursor-instances/cursor_boxnet/home/.cursor`;
    // A Docker-like socket and a local service: neither is prkit's MCP server.
    const socket = `${root}/d.sock`;
    const unix = NodeNet.createServer((client) => client.end("hello"));
    const tcp = NodeNet.createServer((client) => client.end("hello"));
    await new Promise<void>((resolve) => unix.listen(socket, resolve));
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });
        yield* fs.makeDirectory(`${own}/sdk`, { recursive: true });
        yield* fs.makeDirectory(`${own}/projects`, { recursive: true });
        yield* fs.makeDirectory(`${root}/elsewhere`, { recursive: true });
      }),
    );
    try {
      const outcomes = await escapeTurn(
        {
          writes: [
            `${own}/sdk/auth.json`,
            `${own.replace(/cursor$/, "CURSOR")}/sdk/auth.json`,
            `${own}/projects/transcript.txt`,
          ],
          renames: [
            [`${own}/projects`, `${own}/sdk-moved`],
            [`${own}/projects`, `${own}/projects-old`],
          ],
          // A link in its place would send the transcripts' writes anywhere.
          replaces: [[`${root}/elsewhere`, `${own}/projects`]],
          sockets: [socket],
          ports: [
            ["127.0.0.1", port],
            // IPv4-mapped IPv6 reaches the same listener unless IPv6 stays closed.
            ["::ffff:127.0.0.1", port],
            ["::ffff:0.0.0.0", port],
            // IPv6 outside this machine too (a documentation address, never routed).
            ["2001:db8::1", 443],
          ],
        },
        () => events(provider, input),
      );
      expect(outcomes).toEqual([
        `write ${own}/sdk/auth.json: EPERM`,
        `write ${own.replace(/cursor$/, "CURSOR")}/sdk/auth.json: EPERM`,
        `write ${own}/projects/transcript.txt: ok`,
        `rename ${own}/projects -> ${own}/sdk-moved: EPERM`,
        `rename ${own}/projects -> ${own}/projects-old: EPERM`,
        `replace ${own}/projects -> ${root}/elsewhere: EPERM`,
        `socket ${socket}: EPERM`,
        `port 127.0.0.1 ${port}: EPERM`,
        `port ::ffff:127.0.0.1 ${port}: EPERM`,
        `port ::ffff:0.0.0.0 ${port}: EPERM`,
        "port 2001:db8::1 443: EPERM",
      ]);
    } finally {
      unix.close();
      tcp.close();
    }
  });

  it("ends a process the turn started in a session of its own", async () => {
    const provider = await instance("cursor_setsid", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const input = await turnInput("setsid", { _tag: "read-only", tmpDir: `${root}/tmp-setsid` });
    await forget("detached.log");
    await escapeTurn({ detached: 1 }, () => events(provider, input));
    const pids = (await standIn("detached.log")).map(
      (line) => Schema.decodeUnknownSync(Detached)(line).pid,
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const survivors = pids.filter(alive);
    // The stand-in logged these pids itself: stop any that outlived the turn.
    for (const pid of survivors) process.kill(pid, "SIGKILL");
    expect(pids).toHaveLength(1);
    expect(survivors).toEqual([]);
  });

  it("lets a fix's runner write its checkout, but never .git, .cursor or outside", async () => {
    const provider = await instance("cursor_boxfix", { env: { CURSOR_API_KEY: "stand-in-key" } });
    const outside = await privateFiles();
    const tmpDir = `${root}/tmp-boxfix`;
    const input = await turnInput("boxfix", {
      _tag: "write",
      scripts: { _tag: "blocked", reason: "Cursor runs no commands" },
      tmpDir,
    });
    await fsRun(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });
        // A worktree's `.git` is a file naming its git folder.
        yield* fs.writeFileString(`${input.cwd}/.git`, "gitdir: /elsewhere/.git/worktrees/x\n");
        yield* fs.makeDirectory(`${input.cwd}/.cursor`, { recursive: true });
      }),
    );
    const outcomes = await escapeTurn(
      {
        reads: outside,
        writes: [
          `${input.cwd}/src/a.js`,
          `${input.cwd}/.git`,
          `${input.cwd}/.GIT`,
          `${input.cwd}/.cursor/hooks.json`,
          `${input.cwd}/.curſor/sandbox.json`,
          `${root}/written-outside.txt`,
        ],
        renames: [[`${input.cwd}/.git`, `${input.cwd}/moved-git`]],
        links: [[`${input.cwd}/.git`, `${input.cwd}/linked-git`]],
      },
      () =>
        events(provider, {
          ...input,
          prompt: "Call `finish_fixes` with one entry for each of c1, then end your turn.",
        }),
    );
    expect(outcomes).toEqual([
      ...outside.map((file) => `read ${file}: EPERM`),
      `write ${input.cwd}/src/a.js: ok`,
      `write ${input.cwd}/.git: EPERM`,
      `write ${input.cwd}/.GIT: EPERM`,
      `write ${input.cwd}/.cursor/hooks.json: EPERM`,
      `write ${input.cwd}/.curſor/sandbox.json: EPERM`,
      `write ${root}/written-outside.txt: EPERM`,
      `rename ${input.cwd}/.git -> ${input.cwd}/moved-git: EPERM`,
      `link ${input.cwd}/.git -> ${input.cwd}/linked-git: EPERM`,
    ]);
  });
});

describe("removing a Cursor instance", () => {
  it("signs out its key, then deletes its folder", async () => {
    const provider = await instance("cursor_gone");
    await signIn(provider);
    await Effect.runPromise(provider.retire);
    expect(
      await fsRun(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(`${home}/cursor-instances/cursor_gone`);
        }),
      ),
    ).toBe(false);
  });

  it("removes an instance and its saved key even when Cursor support isn't installed", async () => {
    const provider = await instance("cursor_kept");
    await signIn(provider);
    const without = await instance("cursor_kept", { installed: false });
    await Effect.runPromise(without.retire);
    expect(
      await fsRun(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(`${home}/cursor-instances/cursor_kept`);
        }),
      ),
    ).toBe(false);
  });
});
