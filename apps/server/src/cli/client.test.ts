// @effect-diagnostics nodeBuiltinImport:off -- A real HTTP peer cuts the response after dispatch.
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { callTool } from "./client.ts";

it("does not replay an action after its response is lost and closes its MCP session", async () => {
  const directory = NodePath.resolve(".e2e", "unit-cli");
  NodeFs.mkdirSync(directory, { recursive: true });
  const home = NodeFs.mkdtempSync(NodePath.join(directory, "lost-response-"));
  const decode = Schema.decodeOption(
    Schema.fromJsonString(
      Schema.Struct({ id: Schema.optionalKey(Schema.Number), method: Schema.String }),
    ),
  );
  let calls = 0;
  let closed = 0;
  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "DELETE") {
      closed++;
      response.writeHead(202).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = decode(body);
      if (Option.isNone(message)) {
        response.writeHead(400).end();
        return;
      }
      if (message.value.method === "tools/call") {
        calls++;
        response.destroy();
        return;
      }
      if (message.value.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.value.id,
          result:
            message.value.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : { tools: [{ name: "generate_guide" }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("The test peer didn't listen.");
    NodeFs.writeFileSync(
      NodePath.join(home, "outside-agents.json"),
      JSON.stringify({
        _tag: "on",
        pid: process.pid,
        port: address.port,
        token: "test-token",
        version: "0",
        access: "work",
      }),
      { mode: 0o600 },
    );
    const result = await Effect.runPromise(
      callTool(home, "generate_guide", { owner: "acme", repo: "widgets", number: 42 }).pipe(
        Effect.result,
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "CliFailure", code: 3 } });
    expect(calls).toBe(1);
    expect(closed).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    NodeFs.rmSync(home, { recursive: true, force: true });
  }
});
