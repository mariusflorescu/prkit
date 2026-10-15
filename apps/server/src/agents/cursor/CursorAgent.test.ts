// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stand-in for prkit's MCP server, outside Effect
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentInstanceId } from "@prkit/contracts";
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
    resumed: Schema.Boolean,
  }),
);

let root = "";
let home = "";
let control = "";
let mcpUrl = "";
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
  control = `${root}/control`;
  // The stand-in SDK as a package folder, steered from `control`.
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
      yield* fs.writeFileString(
        `${root}/sdk/dist/esm/index.js`,
        source.replace('process.env.FAKE_CURSOR_CONTROL ?? ""', JSON.stringify(control)),
      );
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

/** An instance on the stand-in SDK, or on none when `installed` is false. */
const instance = (
  id: string,
  options: { readonly installed?: boolean; readonly env?: Record<string, string> } = {},
) => {
  if (options.installed === false) delete process.env[SDK_PATH_VARIABLE];
  else process.env[SDK_PATH_VARIABLE] = `${root}/sdk`;
  return run(
    CursorAgent.make({
      id: AgentInstanceId.make(id),
      label: id,
      isDefault: id === "cursor",
      configDir: null,
      binaryPath: null,
      environment: options.env ?? {},
      login: "shared",
    }),
  );
};

const flag = (name: string, on: boolean) =>
  fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (on) yield* fs.writeFileString(`${control}/${name}`, "");
      else yield* fs.remove(`${control}/${name}`, { force: true });
    }),
  );

const runs = () =>
  fsRun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(`${control}/runs.log`))) return [];
      return (yield* fs.readFileString(`${control}/runs.log`))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(Run)(line));
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
    const provider = await instance("cursor_fix", { env: { CURSOR_API_KEY: "stand-in-key" } });
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

  it("keeps an instance signed in when Cursor support isn't there to sign it out", async () => {
    const provider = await instance("cursor_kept");
    await signIn(provider);
    const without = await instance("cursor_kept", { installed: false });
    const exit = await Effect.runPromiseExit(without.retire);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("needs Cursor support");
    expect(
      await fsRun(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(
            `${home}/cursor-instances/cursor_kept/home/.cursor/sdk/auth.json`,
          );
        }),
      ),
    ).toBe(true);
  });
});
