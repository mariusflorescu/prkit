// Phase-1 spike: a minimal MCP server over streamable HTTP that stands in for
// prkit's /mcp. It accepts only `Authorization: Bearer <PROBE_TOKEN>` and logs
// whether each request carried the right token, never the token itself.
// Run: PROBE_TOKEN=... node scripts/cursor-spike/mcp-server.ts <port> <log-file>
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone spike script
import { appendFileSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone spike script
import { createServer } from "node:http";

const [port = "47123", logFile = "/tmp/mcp-probe.log"] = process.argv.slice(2);
const token = process.env.PROBE_TOKEN ?? "";
const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

type Request = { readonly id?: number | string; readonly method: string };

const reply = (request: Request) => {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "prkit-probe", version: "0.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "probe_echo",
            description: "Returns the marker MCP-PROBE-OK. Call it when asked to test MCP.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    case "tools/call":
      return { content: [{ type: "text", text: "MCP-PROBE-OK" }] };
    default:
      return {};
  }
};

createServer((req, res) => {
  const authorized = token !== "" && req.headers.authorization === `Bearer ${token}`;
  log(`${req.method} ${req.url} auth=${authorized ? "ok" : "missing-or-wrong"}`);
  if (!authorized) {
    res.writeHead(401).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    const parsed: Request = JSON.parse(body);
    log(`rpc ${parsed.method}`);
    if (parsed.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: reply(parsed) }));
  });
}).listen(Number(port), "127.0.0.1", () => log(`listening ${port}`));
