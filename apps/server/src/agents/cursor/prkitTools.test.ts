// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stand-in for prkit's MCP server, outside Effect
import * as NodeHttp from "node:http";

import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { connectPrkitTools, PrkitUnreachable } from "./prkitTools.ts";

const TOKEN = "turn-token-4f1c";
let url = "";
const Body = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Number),
    method: Schema.String,
    params: Schema.optionalKey(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        arguments: Schema.optionalKey(
          Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
  }),
);

/** Answers like prkit's MCP server: tools/list, then calls that echo what they got, token and all. */
const server = NodeHttp.createServer((request, response) => {
  let text = "";
  request.on("data", (chunk: Buffer) => (text += chunk.toString()));
  request.on("end", () => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return response.writeHead(401).end("Unauthorized");
    const body = Schema.decodeUnknownSync(Body)(text);
    if (body.id === undefined) return response.writeHead(202).end();
    const result =
      body.method === "tools/list"
        ? {
            tools: ["submit_guide", "report_progress", "finish_fixes"].map((name) => ({
              name,
              description: `prkit's ${name}`,
              inputSchema: { type: "object", properties: { message: { type: "string" } } },
            })),
          }
        : body.method === "tools/call"
          ? {
              content: [
                {
                  type: "text",
                  text: `${body.params?.name} got ${body.params?.arguments?.message}`,
                },
                { type: "text", text: `with Bearer ${TOKEN}` },
              ],
              isError: body.params?.name === "submit_guide",
            }
          : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "prkit" } };
    // Like prkit's server, one answer as a server-sent event.
    response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/mcp`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("prkit's MCP tools through Cursor's runner", () => {
  it("offers only the turn's tools, with prkit's own descriptions and schemas", async () => {
    const tools = await connectPrkitTools({ url, token: TOKEN }, [
      "report_progress",
      "submit_guide",
    ]);
    expect(tools.map((tool) => [tool.name, tool.description])).toEqual([
      ["submit_guide", "prkit's submit_guide"],
      ["report_progress", "prkit's report_progress"],
    ]);
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  it("calls prkit with the token, and never hands the token to the agent", async () => {
    const tools = await connectPrkitTools({ url, token: TOKEN }, [
      "report_progress",
      "submit_guide",
    ]);
    const [submit, progress] = tools;
    const reported = await progress?.run({ message: "Reading" });
    expect(reported).toEqual({
      ok: true,
      text: "report_progress got Reading\nwith Bearer [hidden]",
    });
    const rejected = await submit?.run({ message: "x" });
    expect(rejected?.ok).toBe(false);
    for (const result of [reported, rejected]) expect(result?.text).not.toContain(TOKEN);
  });

  it("fails without leaking anything when prkit turns the token down", async () => {
    const failed = await connectPrkitTools({ url, token: "wrong" }, ["report_progress"]).catch(
      (error: Error) => error,
    );
    expect(failed).toBeInstanceOf(PrkitUnreachable);
    expect(String(failed)).not.toContain(url);
  });
});
