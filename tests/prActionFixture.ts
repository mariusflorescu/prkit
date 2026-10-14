import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../packages/contracts/src/childEnv.ts";
import * as Schema from "effect/Schema";

import { FIXTURE_REPO } from "./fixturePr.ts";
import { waitForPullRef } from "./reviewFixture.ts";

const root = `repos/${FIXTURE_REPO}`;
const gh = <A>(
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: { readonly [key: string]: string | boolean },
) => {
  const result = execFileSync(
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
      env: childEnv(process.env, { GH_CONFIG_DIR: join(homedir(), ".config/gh") }),
    },
  );
  return Schema.decodeSync(Schema.fromJsonString(schema))(result || "{}");
};
const Branch = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
});
const Pull = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  state: Schema.String,
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  merge_commit_sha: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
});
export const readActionFixture = (number: number) => gh(`${root}/pulls/${number}`, Pull);
/**
 * A PR of its own on a base branch of its own, so moving its base, updating its branch or
 * merging it never changes main, which other runs' PRs target.
 */
export const createActionFixture = (
  method: string,
  description = "Disposable PR for the prkit actions journey.",
) => {
  const slug = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `e2e/pr-actions-${slug}`;
  const base = `${branch}-base`;
  const main = gh(root, Schema.Struct({ default_branch: Schema.String })).default_branch;
  const sha = gh(`${root}/branches/${main}`, Branch).commit.sha;
  const title = `PR action fixture ${slug}`;
  try {
    for (const ref of [base, branch])
      gh(`${root}/git/refs`, Schema.Struct({}), "POST", { ref: `refs/heads/${ref}`, sha });
    gh(`${root}/contents/e2e/pr-actions/${slug}.md`, Schema.Struct({}), "PUT", {
      branch,
      message: `test: add PR action fixture ${slug}`,
      content: Buffer.from(`PR actions ${slug}\n`).toString("base64"),
    });
    const pull = gh(`${root}/pulls`, Pull, "POST", {
      head: branch,
      base,
      title,
      body: description,
    });
    waitForPullRef(pull.number);
    mkdirSync(".e2e/evidence/pr-actions", { recursive: true });
    appendFileSync(
      ".e2e/evidence/pr-actions/fixture-prs.jsonl",
      `${JSON.stringify({ number: pull.number, url: pull.html_url, branch, base, slug })}\n`,
    );
    return { number: pull.number, branch, slug, title, base };
  } catch (error) {
    // Half made, its branches would outlive the run. Deleting them closes the PR, if any.
    for (const ref of [branch, base])
      if (actionFixtureBranchExists(ref))
        gh(`${root}/git/refs/heads/${ref}`, Schema.Struct({}), "DELETE");
    throw error;
  }
};
export const advanceFixtureBase = (fixture: ReturnType<typeof createActionFixture>) =>
  gh(`${root}/contents/e2e/pr-actions-base/${fixture.slug}.md`, Schema.Struct({}), "PUT", {
    branch: fixture.base,
    message: `test: advance PR action fixture base ${fixture.slug}`,
    content: Buffer.from(`Base for ${fixture.slug}\n`).toString("base64"),
  });
export const fixtureAllowsAutoMerge = () =>
  gh(root, Schema.Struct({ allow_auto_merge: Schema.Boolean })).allow_auto_merge;
/**
 * GitHub offers Update branch only while the repository suggests updating PR branches
 * (`viewerCanUpdateBranch` is false otherwise). Every run shares that setting, so the
 * journeys check it instead of changing it.
 */
export const requireBranchUpdates = () => {
  if (!gh(root, Schema.Struct({ allow_update_branch: Schema.Boolean })).allow_update_branch)
    throw new Error(
      "The fixture repository must suggest updating pull request branches (Settings > General > Pull Requests > Always suggest updating pull request branches).",
    );
};
export const advanceFixtureHead = (fixture: ReturnType<typeof createActionFixture>) =>
  gh(`${root}/contents/e2e/pr-actions-head/${fixture.slug}.md`, Schema.Struct({}), "PUT", {
    branch: fixture.branch,
    message: `test: advance PR action fixture head ${fixture.slug}`,
    content: Buffer.from(`Head for ${fixture.slug}\n`).toString("base64"),
  });
export const actionFixtureBranchExists = (branch: string) => {
  try {
    gh(`${root}/git/ref/heads/${branch}`, Schema.Struct({}));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return false;
    throw error;
  }
};
export const actionFixtureCommit = (sha: string) =>
  gh(
    `${root}/commits/${sha}`,
    Schema.Struct({
      commit: Schema.Struct({ message: Schema.String }),
      parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
    }),
  );
/** Closes the PR and deletes its branch and the base the fixture made. Safe to run twice. */
export const cleanupActionFixture = (number: number) => {
  const pull = readActionFixture(number);
  if (pull.state === "open")
    gh(`${root}/pulls/${number}`, Schema.Struct({}), "PATCH", { state: "closed" });
  const made = [pull.head.ref, pull.base.ref].filter(
    (ref) =>
      ref.startsWith("e2e/pr-actions-") ||
      (ref.startsWith("revert-") && ref.includes("e2e/pr-actions-")),
  );
  for (const ref of made)
    if (actionFixtureBranchExists(ref))
      gh(`${root}/git/refs/heads/${ref}`, Schema.Struct({}), "DELETE");
};
export const setActionFixtureCheck = (number: number, state: "pending" | "failure" | "success") =>
  gh(`${root}/statuses/${readActionFixture(number).head.sha}`, Schema.Struct({}), "POST", {
    state,
    context: "prkit/e2e-actions",
    description: `PR action journey ${state}`,
  });
