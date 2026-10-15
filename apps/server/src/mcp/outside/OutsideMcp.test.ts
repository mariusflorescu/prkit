// @effect-diagnostics globalFetch:off -- the test is an MCP client, the way the bridge is

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OUTSIDE_AGENTS_DEFAULTS,
  OUTSIDE_MCP_PATH,
  type OutsideAgentsSettings,
} from "@prkit/contracts";
import { AttemptId, ReviewId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import { PRKIT_TOOLS } from "../../agents/AgentProvider.ts";
import { Fixers } from "../../fixers/Fixers.ts";
import { boundPort } from "../../listenAddress.ts";
import { OutsideAgents } from "../../outside/OutsideAgents.ts";
import { OutsideWork } from "../../outside/OutsideWork.ts";
import { Reviews } from "../../reviews/Reviews.ts";
import * as McpHttp from "../McpHttp.ts";
import * as McpTokens from "../McpTokens.ts";
import { levelsOf } from "./access.ts";
import * as OutsideMcp from "./OutsideMcp.ts";
import { makeOutsideToolkit } from "./tools.ts";

const READS = [
  "prkit_status",
  "list_inbox",
  "list_open_pull_requests",
  "read_pull_request",
  "read_guide",
  "list_review_comments",
  "read_fix",
  "wait_for",
];
const STARTS_WORK = [
  "open_pull_request",
  "generate_guide",
  "stop_guide",
  "add_review_comment",
  "send_to_fix_agent",
  "ask_fix_agent_to_change",
  "stop_fix",
  "retry_fix",
  "resolve_conflicts",
];

const Answer = Schema.Struct({
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  result: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      isError: Schema.optionalKey(Schema.Boolean),
      content: Schema.optionalKey(
        Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});
const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(Answer));

/** One MCP session against `path`, the way a client opens it. */
const session = async (
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  call: (method: string, params?: object) => Promise<typeof Answer.Type>;
}> => {
  const post = (body: object, session: string | null) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
        ...(session === null
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
      },
      body: JSON.stringify(body),
    });
  const opened = await post(
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test client", version: "1" },
      },
    },
    null,
  );
  const id = opened.headers.get("mcp-session-id");
  await opened.text();
  let next = 1;
  return {
    status: opened.status,
    call: async (method, params) => {
      const response = await post({ jsonrpc: "2.0", id: next++, method, params: params ?? {} }, id);
      const text = await response.text();
      const json = text.includes("data:")
        ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5)
        : text;
      return decodeAnswer(json.trim());
    },
  };
};

const names = (answer: typeof Answer.Type) =>
  (answer.result?.tools ?? []).map((tool) => tool.name).sort();

describe("outside agents' MCP endpoint", () => {
  it("declares every tool with its level", () => {
    expect(levelsOf(makeOutsideToolkit(() => true))).toEqual([
      ...READS.map((name) => ({ name, level: "reads" })),
      ...STARTS_WORK.map((name) => ({ name, level: "starts-work" })),
    ]);
  });

  it("lists by level, refuses outsiders, and leaves agent turns' tools as they were", async () => {
    let settings: OutsideAgentsSettings = { ...OUTSIDE_AGENTS_DEFAULTS, enabled: true };
    const layerOutside = Layer.mock(OutsideAgents, {
      current: () => settings,
      accepts: (token: string) => Effect.succeed(token === "right"),
      seen: () => Effect.void,
      discoveryPath: "",
      launcher: "",
      port: () => Option.none(),
    });
    const layerWork = Layer.mock(OutsideWork, {
      open: () => Effect.succeed({ active: null, open: [] }),
    });
    const layerApp = HttpRouter.serve(Layer.mergeAll(McpHttp.layer, OutsideMcp.layer), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerOutside,
          layerWork,
          McpTokens.layer,
          Layer.mock(Reviews, {}),
          Layer.mock(Fixers, {}),
        ),
      ),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const port = Option.getOrThrow(boundPort(server.address));
        const base = `http://127.0.0.1:${port}`;
        const tokens = yield* McpTokens.McpTokens;
        const turn = yield* tokens.issue({
          _tag: "guide",
          attemptId: AttemptId.make("attempt"),
          reviewId: ReviewId.make("review"),
        });
        yield* Effect.promise(async () => {
          // Agent turns see exactly prkit's own tools, none of the outside ones.
          const agent = await session(base, "/mcp", {
            authorization: `Bearer ${Redacted.value(turn)}`,
          });
          expect(names(await agent.call("tools/list"))).toEqual([...PRKIT_TOOLS].sort());

          const bearer = { authorization: "Bearer right" };
          const reader = await session(base, OUTSIDE_MCP_PATH, bearer);
          expect(names(await reader.call("tools/list"))).toEqual([...READS].sort());
          const refused = await reader.call("tools/call", {
            name: "open_pull_request",
            arguments: { url: "https://github.com/acme/widgets/pull/1" },
          });
          // Hidden at Read only, so the server doesn't know it for this client.
          expect(refused.error?.message).toContain("not found");

          settings = { ...settings, access: "work" };
          expect(names(await reader.call("tools/list"))).toEqual([...READS, ...STARTS_WORK].sort());
          const opened = await reader.call("tools/call", {
            name: "open_pull_request",
            arguments: { url: "https://github.com/acme/widgets/pull/1" },
          });
          expect(opened.result?.isError).toBe(false);

          // The level can drop while a client is connected; the next call is checked again.
          settings = { ...settings, access: "read" };
          const again = await reader.call("tools/call", {
            name: "open_pull_request",
            arguments: { url: "https://github.com/acme/widgets/pull/1" },
          });
          expect(again.error?.message).toContain("not found");

          expect((await session(base, OUTSIDE_MCP_PATH, {})).status).toBe(401);
          expect(
            (await session(base, OUTSIDE_MCP_PATH, { authorization: "Bearer wrong" })).status,
          ).toBe(401);
          expect(
            (await session(base, OUTSIDE_MCP_PATH, { ...bearer, origin: "https://example.com" }))
              .status,
          ).toBe(403);
          // A turn's token is no key to the outside endpoint, and the outside token none to /mcp.
          expect(
            (
              await session(base, OUTSIDE_MCP_PATH, {
                authorization: `Bearer ${Redacted.value(turn)}`,
              })
            ).status,
          ).toBe(401);
          expect((await session(base, "/mcp", bearer)).status).toBe(401);
          settings = { ...settings, enabled: false };
          expect((await session(base, OUTSIDE_MCP_PATH, bearer)).status).toBe(403);
        });
      }).pipe(Effect.scoped, Effect.provide(layerApp)),
    );
  });
});
