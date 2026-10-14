import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import { FIXTURE_REPO } from "./fixturePr.ts";
import { waitForPullRef } from "./reviewFixture.ts";

const root = `repos/${FIXTURE_REPO}`;
const env = () =>
  childEnv(process.env, { GH_CONFIG_DIR: NodePath.join(NodeOS.homedir(), ".config/gh") });
const gh = <A>(
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: { readonly [key: string]: string },
) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(
    NodeChildProcess.execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        method,
        path,
        ...(body === undefined ? [] : ["--input", "-"]),
      ],
      {
        input: body === undefined ? undefined : JSON.stringify(body),
        encoding: "utf8",
        stdio: "pipe",
        env: env(),
      },
    ) || "{}",
  );
const Ref = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const Content = Schema.Struct({ sha: Schema.String, content: Schema.String });
const Written = Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) });
const Pull = Schema.Struct({
  number: Schema.Int,
  state: Schema.String,
  merged: Schema.Boolean,
  stack: Schema.optionalKey(Schema.NullOr(Schema.Struct({ number: Schema.Int }))),
});

const SLUG = `// Turns a title into a short, readable code: "Hello, World!" becomes "hello-world".
export const MAX_SLUG_LENGTH = 32;

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}
`;
const VANITY = `import { slugify } from "./slug.js";

// A readable code for a link: the title's slug, with -2, -3, ... when it is taken.
export function vanityCode(store, title) {
  const base = slugify(title);
  if (base === "") return null;
  let code = base;
  for (let n = 2; store.has(code); n++) code = \`\${base}-\${n}\`;
  return code;
}
`;

const put = (branch: string, path: string, content: (current: string | null) => string) => {
  let current: typeof Content.Type | null = null;
  try {
    current = gh(`${root}/contents/${path}?ref=${encodeURIComponent(branch)}`, Content);
  } catch {
    current = null;
  }
  const before = current === null ? null : Buffer.from(current.content, "base64").toString("utf8");
  return gh(`${root}/contents/${path}`, Written, "PUT", {
    branch,
    message: `test: stack fixture ${path}`,
    content: Buffer.from(content(before)).toString("base64"),
    ...(current === null ? {} : { sha: current.sha }),
  }).commit.sha;
};

/** Runs `gh stack` against the fixture from an empty repository with its origin, as a teammate would. */
const stackCommand = (args: ReadonlyArray<string>, check: boolean) => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-stack-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "-q", scratch], { env: env() });
    NodeChildProcess.execFileSync(
      "git",
      ["-C", scratch, "remote", "add", "origin", `https://github.com/${FIXTURE_REPO}.git`],
      { env: env() },
    );
    const result = NodeChildProcess.spawnSync("gh", ["stack", ...args], {
      cwd: scratch,
      env: env(),
      encoding: "utf8",
    });
    if (check && result.status !== 0)
      throw new Error(`gh stack ${args.join(" ")} failed: ${result.stderr}`);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
};

const branchExists = (branch: string) => {
  try {
    gh(`${root}/git/ref/heads/${branch}`, Schema.Struct({}));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return false;
    throw error;
  }
};

/**
 * Unstacks, closes and deletes the fixture's layers, their branches and its trunk, then
 * returns what it couldn't clean up. GitHub keeps a merged layer in its stack (`gh stack
 * unstack` refuses it and unstacks the rest), so a fixture whose bottom layer merged leaves
 * a stack of that one merged PR, which is not reported. Safe to run twice.
 */
export const cleanupStackFixture = (fixture: {
  readonly stack: number | null;
  readonly numbers: ReadonlyArray<number>;
  readonly layers: ReadonlyArray<{ readonly branch: string }>;
  readonly trunk: string;
}) => {
  const left: Array<string> = [];
  const attempt = (what: string, step: () => void) => {
    try {
      step();
    } catch (error) {
      left.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const { stack } = fixture;
  if (stack !== null)
    attempt(`unstack ${stack}`, () => stackCommand(["unstack", String(stack)], false));
  for (const number of fixture.numbers.toReversed())
    attempt(`close #${number}`, () => {
      if (gh(`${root}/pulls/${number}`, Pull).state === "open")
        gh(`${root}/pulls/${number}`, Schema.Struct({}), "PATCH", { state: "closed" });
    });
  for (const branch of [...fixture.layers.map((layer) => layer.branch), fixture.trunk])
    attempt(`delete ${branch}`, () => {
      if (branchExists(branch)) gh(`${root}/git/refs/heads/${branch}`, Schema.Struct({}), "DELETE");
    });
  for (const number of fixture.numbers)
    attempt(`unstack #${number}`, () => {
      const pull = gh(`${root}/pulls/${number}`, Pull);
      const still = pull.stack?.number;
      if (still !== undefined && !pull.merged) throw new Error(`still in stack ${still}`);
    });
  return left;
};

/**
 * A three-layer GitHub stack of its own on the fixture repo, so a run never shares
 * reviews with another: layer 1 adds `slugify`, layer 2 calls it, layer 3 wires it in.
 * The bottom layer targets a trunk branch the fixture makes, so merging a layer never
 * changes main. The layers are linked with the real `gh stack link`. A fixture that fails
 * half made cleans up what it made before it throws.
 */
export const createStackFixture = (stamp: string) => {
  const layer = (
    name: string,
    title: string,
    path: string,
    content: (current: string | null) => string,
  ) => ({
    branch: `e2e/stack-${stamp}-${name}`,
    title: `Stack fixture ${stamp}: ${title}`,
    path,
    content,
  });
  const layers = [
    layer("slug", "turn titles into slugs", "src/slug.js", () => SLUG),
    layer("vanity", "vanity codes from titles", "src/vanity.js", () => VANITY),
    layer("route", "links take an optional title", "src/shorten.js", (current) =>
      `import { vanityCode } from "./vanity.js";\n${current ?? ""}`.replace(
        "let code = randomCode();",
        "let code = vanityCode(store, url) ?? randomCode();",
      ),
    ),
  ];
  const trunk = `e2e/stack-${stamp}-trunk`;
  const numbers: Array<number> = [];
  let stack: number | null = null;
  try {
    let sha = gh(`${root}/git/ref/heads/main`, Ref).object.sha;
    gh(`${root}/git/refs`, Schema.Struct({}), "POST", { ref: `refs/heads/${trunk}`, sha });
    let base = trunk;
    for (const { branch, title, path, content } of layers) {
      gh(`${root}/git/refs`, Schema.Struct({}), "POST", { ref: `refs/heads/${branch}`, sha });
      sha = put(branch, path, content);
      numbers.push(
        waitForPullRef(
          gh(`${root}/pulls`, Pull, "POST", {
            head: branch,
            base,
            title,
            body: "Opened by the stacks journey. It closes itself when the run ends.",
          }).number,
        ),
      );
      base = branch;
    }
    stackCommand(["link", "--base", trunk, ...numbers.map(String)], true);
    stack = gh(`${root}/pulls/${numbers[0]}`, Pull).stack?.number ?? null;
    if (stack === null) throw new Error("gh stack link didn't make the fixture PRs a stack.");
    return { stack, numbers, trunk, layers };
  } catch (error) {
    const left = cleanupStackFixture({ stack, numbers, layers, trunk });
    if (left.length > 0) console.error(`[stacks] the half-made fixture left: ${left.join("; ")}`);
    throw error;
  }
};

/** Squash-merges the stack's bottom layer into its trunk on GitHub, the way `gh stack merge` does. */
export const squashMergeBottom = (fixture: { numbers: ReadonlyArray<number> }) =>
  stackCommand(["merge", String(fixture.numbers[0]), "--yes", "--squash"], true);
