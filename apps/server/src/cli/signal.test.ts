// @effect-diagnostics nodeBuiltinImport:off -- A real CLI child receives process signals while an HTTP peer waits.
// @effect-diagnostics globalTimers:off -- Native HTTP callbacks and a child-process deadline keep this signal test independent of the Effect runtime under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { childEnv } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decode = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.optionalKey(Schema.Number), method: Schema.String }),
  ),
);

it.each([
  { signal: "SIGINT", streaming: false },
  { signal: "SIGINT", streaming: true },
  { signal: "SIGTERM", streaming: true },
] as const)("closes wait's session on $signal (streaming: $streaming)", async (test) => {
  const directory = NodePath.resolve(".e2e", "unit-cli");
  NodeFs.mkdirSync(directory, { recursive: true });
  const home = NodeFs.mkdtempSync(NodePath.join(directory, "interrupted-"));
  const started = Promise.withResolvers<void>();
  let deleted = 0;
  let aborted = false;
  let abortedBeforeDeleteReply = false;
  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "DELETE") {
      deleted++;
      // Keep the child alive long enough to distinguish cancellation from process exit.
      setTimeout(() => {
        abortedBeforeDeleteReply = aborted;
        response.writeHead(202).end();
      }, 50);
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
        response.on("close", () => {
          aborted = true;
        });
        if (test.streaming) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write('data: {"jsonrpc":');
          // Let the CLI enter response.text() before interrupting the unfinished body.
          setTimeout(() => started.resolve(), 100);
        } else {
          started.resolve();
        }
        return;
      }
      if (message.value.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "wait-session",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.value.id,
          result:
            message.value.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : { tools: [{ name: "wait_for" }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
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
        access: "read",
      }),
      { mode: 0o600 },
    );
    child = NodeChildProcess.spawn(
      process.execPath,
      [
        new URL("../bin.ts", import.meta.url).pathname,
        "cli",
        "wait",
        "acme/widgets#42",
        "--for",
        "guide",
        "--timeout",
        "600",
        "--json",
      ],
      {
        env: childEnv(process.env, {
          HOME: home,
          PRKIT_HOME: home,
          PRKIT_CLI_INSTALL_PATH: NodePath.join(home, "local-bin", "prkit"),
        }),
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = Promise.withResolvers<number | null>();
    child.on("error", exited.reject);
    child.on("close", (code) => exited.resolve(code));
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`CLI did not finish: ${stderr}`)), 5000);
    });
    await Promise.race([
      started.promise,
      exited.promise.then((code) => {
        throw new Error(`CLI exited before waiting (${code}): ${stderr}`);
      }),
      deadline,
    ]);
    expect(child.kill(test.signal)).toBe(true);
    expect(await Promise.race([exited.promise, deadline])).toBe(130);
    expect(deleted).toBe(1);
    expect(abortedBeforeDeleteReply).toBe(true);
    expect(stderr).toBe("");
  } finally {
    clearTimeout(timeout);
    if (child !== undefined && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    NodeFs.rmSync(home, { recursive: true, force: true });
  }
});
