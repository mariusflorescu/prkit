import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import * as Schema from "effect/Schema";

import { startCursorControl } from "../apps/server/src/agents/cursor/fakeControl.ts";
import { repoRoot } from "../scripts/verify-run.ts";

const VERSION = "1.0.37";

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
const Call = Schema.fromJsonString(
  Schema.Struct({ tool: Schema.String, ok: Schema.Boolean, text: Schema.String }),
);

/** One call a stand-in turn makes before its work: a tool name and its arguments. */
export interface ProbeStep {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
}

/** An npm-style tarball of `files` under `package/`, and its sha512 integrity. */
const pack = (dir: string, name: string, files: Readonly<Record<string, string>>) => {
  const staging = NodePath.join(dir, "staging", name);
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(staging, "package", file)), {
      recursive: true,
    });
    NodeFS.writeFileSync(NodePath.join(staging, "package", file), content);
  }
  const tarball = NodePath.join(dir, `${name}-${VERSION}.tgz`);
  NodeChildProcess.execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", staging, "package"]);
  const integrity = `sha512-${NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(tarball)).digest("base64")}`;
  return { url: NodeUrl.pathToFileURL(tarball).href, integrity };
};

/**
 * The stand-in Cursor SDK of scripts/fake-cursor-sdk.mjs, packed as the tarballs prkit installs:
 * pass `manifest` to `verify-app start --e2e --cursor-manifest`, and "Install Cursor support"
 * unpacks them from file URLs, checked like npm's, without the network. `approveLogin` finishes
 * a sign-in waiting in the browser; `runs` lists every turn the stand-in started.
 */
export const setUpFakeCursor = async (name: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-cursor`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  const control = NodePath.join(dir, "control");
  // The stand-in runs in the runner's sandbox, so it reaches `control` through this server.
  const server = await startCursorControl(control);
  const source = NodeFS.readFileSync(
    NodePath.join(repoRoot, "scripts", "fake-cursor-sdk.mjs"),
    "utf8",
  );
  const sdk = pack(dir, "sdk", {
    "package.json": JSON.stringify({ name: "@cursor/sdk", version: VERSION, type: "module" }),
    "dist/esm/index.js": source.replace(
      'process.env.FAKE_CURSOR_CONTROL ?? ""',
      JSON.stringify(server.url),
    ),
  });
  const platform = (arch: string) => ({
    name: `@cursor/sdk-darwin-${arch}`,
    version: VERSION,
    platform: `darwin-${arch}`,
    ...pack(dir, `sdk-darwin-${arch}`, {
      "package.json": JSON.stringify({ name: `@cursor/sdk-darwin-${arch}`, version: VERSION }),
    }),
  });
  const manifest = NodePath.join(dir, "manifest.json");
  NodeFS.writeFileSync(
    manifest,
    JSON.stringify([
      { name: "@cursor/sdk", version: VERSION, ...sdk },
      platform("arm64"),
      platform("x64"),
    ]),
  );
  const flag = (what: string, on: boolean) =>
    on
      ? NodeFS.writeFileSync(NodePath.join(control, what), "")
      : NodeFS.rmSync(NodePath.join(control, what), { force: true });
  const lines = (name: string) => {
    const file = NodePath.join(control, name);
    if (!NodeFS.existsSync(file)) return [];
    return NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  };
  return {
    manifest,
    approveLogin: () => flag("approve-login", true),
    runs: () => lines("runs.log").map((line) => Schema.decodeUnknownSync(Run)(line)),
    /** Every custom tool call the stand-in made, with whether it worked and what it returned. */
    calls: () => lines("calls.log").map((line) => Schema.decodeUnknownSync(Call)(line)),
    /** Calls each later turn makes first, as an agent trying its tools would. */
    probe: (steps: ReadonlyArray<ProbeStep>) =>
      NodeFS.writeFileSync(NodePath.join(control, "probe.json"), JSON.stringify(steps)),
  };
};
