/**
 * A local update feed for `--mock-updates` builds (docs/operations/desktop-build.md). Serves a
 * folder of release files: the update manifests (latest-mac.yml, nightly-mac.yml), the zips and
 * their blockmaps. A manifest without release notes gets fake ones in the release body format.
 *
 *   node scripts/mock-update-server.ts --root <dir> [--port <port>] [--notes <file.json>]
 *        [--throttle <KB/s>] [--latency <ms>]
 *
 * --port         defaults to PRKIT_DESKTOP_MOCK_UPDATE_PORT, else 7357, as the build does.
 * --notes        a JSON array of {"version","note"} for every manifest, newest first.
 * --throttle     slows file downloads, so the app's download progress can be watched.
 * --latency      holds every answer this long, so the app's "Checking" state can be seen.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { resolveMockUpdatePort } from "./desktop-artifact/config.ts";

const say = (message: string) => process.stdout.write(`[mock-update-server] ${message}\n`);

const NotesFile = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ version: Schema.String, note: Schema.String })),
);

const { values } = NodeUtil.parseArgs({
  options: {
    root: { type: "string" },
    port: { type: "string" },
    notes: { type: "string" },
    throttle: { type: "string" },
    latency: { type: "string" },
  },
});
if (values.root === undefined) {
  say("--root <dir> is required: the folder with the manifests and the zips.");
  process.exit(1);
}
const root = NodeFS.realpathSync(NodePath.resolve(values.root));
const port =
  values.port === undefined
    ? resolveMockUpdatePort(process.env)
    : resolveMockUpdatePort({ PRKIT_DESKTOP_MOCK_UPDATE_PORT: values.port });
if (port === undefined) {
  say("The port must be a number.");
  process.exit(1);
}
const bytesPerSecond = values.throttle === undefined ? undefined : Number(values.throttle) * 1024;
const latencyMs = values.latency === undefined ? 0 : Number(values.latency);
const notes =
  values.notes === undefined
    ? undefined
    : Schema.decodeSync(NotesFile)(NodeFS.readFileSync(values.notes, "utf8"));

/** A release body as cliff.toml writes it, with links to pull requests of a placeholder repository. */
const fakeNote = (version: string) => `### Features

- Show what's new before you update ([#41](https://github.com/acme/widgets/pull/41))
- Switch between the Stable and Nightly tracks in Settings ([#42](https://github.com/acme/widgets/pull/42))

### Fixes

- Keep the update button in view while it downloads ${version} ([#43](https://github.com/acme/widgets/pull/43))`;

/** YAML reads JSON, so the notes go in as one JSON line. */
const withNotes = (manifest: string) => {
  if (/^releaseNotes:/m.test(manifest)) return manifest;
  const version = /^version:\s*(\S+)/m.exec(manifest)?.[1] ?? "";
  const entries = notes ?? [{ version, note: fakeNote(version) }];
  return `${manifest.trimEnd()}\nreleaseNotes: ${JSON.stringify(entries)}\n`;
};

const inside = (file: string) => {
  const relative = NodePath.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const listing = () =>
  `<!doctype html><title>Mock releases</title><h1>Mock releases</h1><ul>${NodeFS.readdirSync(root)
    .sort()
    .map((name) => `<li><a href="/${encodeURIComponent(name)}">${name}</a></li>`)
    .join("")}</ul>`;

/** Streams a file at `bytesPerSecond`, in quarter-second slices. */
const sendThrottled = (file: string, response: NodeHttp.ServerResponse, rate: number) => {
  const stream = NodeFS.createReadStream(file, { highWaterMark: Math.max(1024, rate / 4) });
  stream.on("data", (chunk) => {
    response.write(chunk);
    stream.pause();
    setTimeout(() => stream.resume(), 250);
  });
  stream.on("end", () => response.end());
  stream.on("error", () => response.destroy());
};

const answer = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  const path = decodeURIComponent((request.url ?? "/").split("?", 1)[0] ?? "/");
  say(`${request.method ?? "GET"} ${path}`);
  if (path === "/" || path === "/releases") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(listing());
    return;
  }
  const file = NodePath.resolve(root, `.${path}`);
  if (
    path.includes("\0") ||
    !inside(file) ||
    !NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile()
  ) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
    return;
  }
  if (file.endsWith(".yml")) {
    response.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
    response.end(withNotes(NodeFS.readFileSync(file, "utf8")));
    return;
  }
  const size = NodeFS.statSync(file).size;
  response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  if (bytesPerSecond === undefined) NodeFS.createReadStream(file).pipe(response);
  else sendThrottled(file, response, bytesPerSecond);
};

const server = NodeHttp.createServer((request, response) => {
  if (latencyMs > 0) setTimeout(() => answer(request, response), latencyMs);
  else answer(request, response);
});

server.listen(port, "127.0.0.1", () => say(`serving ${root} at http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
