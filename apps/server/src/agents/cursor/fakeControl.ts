// @effect-diagnostics nodeBuiltinImport:off -- a test helper outside the Effect runtime, shared with the e2e journeys
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/**
 * How a test steers the stand-in Cursor SDK (scripts/fake-cursor-sdk.mjs) and reads what it did. Cursor's
 * runner runs in a sandbox that opens none of a test's folders, only the network, so the
 * stand-in asks this server: `GET /flag/<name>` says whether `<dir>/<name>` exists, `GET
 * /file/<name>` returns it, and `POST /log/<name>` appends a line to it. The test reads and
 * writes `dir` directly.
 */
export const startCursorControl = async (dir: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const server = NodeHttp.createServer((request, response) => {
    const match = /^\/(flag|file|log)\/([a-z0-9.-]+)$/.exec(request.url ?? "");
    if (match === null) return response.writeHead(404).end();
    const [, kind, name = ""] = match;
    const file = NodePath.join(dir, name);
    if (kind === "flag") return response.end(NodeFS.existsSync(file) ? "1" : "0");
    if (kind === "file")
      return NodeFS.existsSync(file)
        ? response.end(NodeFS.readFileSync(file))
        : response.writeHead(404).end();
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      NodeFS.appendFileSync(file, `${body}\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A test process ends when its work does, whether or not this server still listens.
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
