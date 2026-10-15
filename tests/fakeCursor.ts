import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import * as Schema from "effect/Schema";

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
const At = Schema.fromJsonString(Schema.Struct({ at: Schema.Number }));
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
export const setUpFakeCursor = (name: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-cursor`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  // The stand-in runs in the runner's sandbox: it reads `control/` in the SDK it was installed as,
  // and logs to `stand-in/` in each instance's home (fake-cursor-sdk.mjs).
  const home = NodePath.join(repoRoot, ".e2e", "homes", name);
  const control = NodePath.join(
    home,
    "cursor-sdk",
    VERSION,
    "node_modules",
    "@cursor",
    "sdk",
    "control",
  );
  const source = NodeFS.readFileSync(
    NodePath.join(repoRoot, "scripts", "fake-cursor-sdk.mjs"),
    "utf8",
  );
  const sdk = pack(dir, "sdk", {
    "package.json": JSON.stringify({ name: "@cursor/sdk", version: VERSION, type: "module" }),
    "dist/esm/index.js": source,
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
  const write = (what: string, content: string) => {
    NodeFS.mkdirSync(control, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(control, what), content);
  };
  /** Every line the stand-in logged as `log`, in every instance's home, oldest first. */
  const lines = (log: string) =>
    NodeFS.globSync(NodePath.join(home, "cursor-instances", "*", "home", "stand-in", log))
      .flatMap((file) => NodeFS.readFileSync(file, "utf8").split("\n"))
      .filter((line) => line !== "")
      .map((line) => ({ at: Schema.decodeUnknownSync(At)(line).at, line }))
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.line);
  return {
    manifest,
    approveLogin: () => write("approve-login", ""),
    runs: () => lines("runs.log").map((line) => Schema.decodeUnknownSync(Run)(line)),
    /** Every custom tool call the stand-in made, with whether it worked and what it returned. */
    calls: () => lines("calls.log").map((line) => Schema.decodeUnknownSync(Call)(line)),
    /** Calls each later turn makes first, as an agent trying its tools would. */
    probe: (steps: ReadonlyArray<ProbeStep>) => write("probe.json", JSON.stringify(steps)),
  };
};
