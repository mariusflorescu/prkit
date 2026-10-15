// @effect-diagnostics nodeBuiltinImport:off -- A real CLI child sends parsed schema arguments to a local MCP peer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { childEnv } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type { ToolName } from "./commands.ts";

const cases = [
  {
    args: ["inbox", "--reason", "authored", "--repo", "acme/widgets"],
    name: "list_inbox",
    expected: {
      reason: "authored",
      repository: { host: "github.com", owner: "acme", name: "widgets" },
    },
  },
  {
    args: [
      "repos",
      "prs",
      "acme/widgets",
      "--host",
      "git.example.test",
      "--limit",
      "2",
      "--cursor",
      "opaque-page",
    ],
    name: "list_repository_pull_requests",
    expected: {
      owner: "acme",
      repo: "widgets",
      host: "git.example.test",
      limit: 2,
      cursor: "opaque-page",
    },
  },
  {
    args: [
      "inbox",
      "filters",
      "save",
      "--search",
      "repair",
      "--account",
      "github.com/octocat",
      "--repo",
      "acme/widgets",
    ],
    name: "save_inbox_filters",
    expected: {
      search: "repair",
      account: "github.com/octocat",
      repository: {
        host: "github.com",
        owner: "acme",
        name: "widgets",
        accountIds: ["github.com/octocat"],
      },
    },
  },
  {
    args: ["inbox", "filters", "save", "--search", "", "--account", "null", "--repo", "null"],
    name: "save_inbox_filters",
    expected: { search: "", account: null, repository: null },
  },
  {
    args: ["guide", "settings", "acme/widgets#42"],
    name: "read_guide_settings",
    expected: { owner: "acme", repo: "widgets", number: 42, host: "github.com" },
  },
  {
    args: [
      "guide",
      "settings",
      "save",
      "acme/widgets#42",
      "--expected-version",
      "2",
      "--edit",
      '{"_tag":"guidance","mode":"append","text":"Check parsing"}',
    ],
    name: "save_pull_request_guide_settings",
    expected: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      host: "github.com",
      expectedVersion: 2,
      edit: { _tag: "guidance", mode: "append", text: "Check parsing" },
    },
  },
  {
    args: ["guide", "scope", "--scope", '{"_tag":"global"}'],
    name: "read_guide_scope",
    expected: { scope: { _tag: "global" } },
  },
  {
    args: [
      "guide",
      "generate",
      "acme/widgets#42",
      "--stack",
      "1,3",
      "--option",
      "effort=high",
      "--option",
      "fast=false",
      "--focus",
      '{"expectedVersion":0,"areas":[],"overrides":[]}',
      "--guidance",
      '{"expectedVersion":0,"text":"Check parsing","mode":"append"}',
    ],
    name: "generate_guide",
    expected: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      host: "github.com",
      stack: "chosen-layers",
      layers: [1, 3],
      options: [
        { id: "effort", value: "high" },
        { id: "fast", value: false },
      ],
      focus: { expectedVersion: 0, areas: [], overrides: [] },
      guidance: { expectedVersion: 0, text: "Check parsing", mode: "append" },
    },
  },
  {
    args: [
      "guide",
      "generate",
      "acme/widgets#42",
      "--stack",
      "all",
      "--layers",
      "1",
      "--layers",
      "2",
    ],
    name: "generate_guide",
    expected: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      host: "github.com",
      stack: "whole-stack",
      layers: [1, 2],
    },
  },
] satisfies ReadonlyArray<{ args: string[]; name: ToolName; expected: Schema.Json }>;

const decodeRequest = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Json),
    }),
  ),
);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

it.each(cases)("sends the schema arguments for $name ($args)", async (test) => {
  const directory = NodePath.resolve(".e2e", "unit-cli");
  NodeFs.mkdirSync(directory, { recursive: true });
  const home = NodeFs.mkdtempSync(NodePath.join(directory, "runtime-"));
  let deleted = 0;
  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "DELETE") {
      deleted++;
      response.writeHead(202).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = decodeRequest(body);
      if (Option.isNone(message)) {
        response.writeHead(400).end();
        return;
      }
      if (message.value.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "runtime-session",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.value.id,
          result:
            message.value.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : message.value.method === "tools/list"
                ? { tools: [{ name: test.name }] }
                : { content: [], structuredContent: message.value.params },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("The MCP peer did not listen.");
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
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [new URL("../bin.ts", import.meta.url).pathname, "cli", ...test.args, "--json"],
          {
            env: childEnv(process.env, {
              HOME: home,
              PRKIT_HOME: home,
              PRKIT_CLI_INSTALL_PATH: NodePath.join(home, "local-bin", "prkit"),
            }),
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, code }));
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code, result.stderr).toBe(0);
    expect(decodeJson(result.stdout)).toEqual({ name: test.name, arguments: test.expected });
    expect(deleted).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    NodeFs.rmSync(home, { recursive: true, force: true });
  }
});
