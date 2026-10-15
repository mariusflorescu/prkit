import * as NodeChildProcess from "node:child_process";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startFakeGitHub } from "./fakeGitHub.ts";
import { outsideGit } from "./outsideGit.ts";

test("records unsupported REST writes and GraphQL mutations at ingress, even when refused", async () => {
  const fake = await startFakeGitHub("outside-write-audit");
  try {
    await fetch(`${fake.url}/repos/budget/fixtures/pulls/1`, {
      method: "PATCH",
      body: '{"title":"Attempt"}',
    });
    await fetch(`${fake.url}/unknown`, { method: "DELETE" });
    await fake.limit("core", 60);
    await fetch(`${fake.url}/another`, { method: "PUT" });
    await fetch(`${fake.url}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query: "# comment\n mutation Unexpected { unsupportedWrite }" }),
    });
    expect((await fake.writes()).map((entry) => entry.kind)).toEqual([
      "PATCH pulls/1",
      "DELETE /unknown",
      "PUT /another",
      "graphql mutation",
    ]);
    await fetch(`${fake.url}/repos/budget/fixtures/actions/runs/7001/approve`, {
      method: "POST",
    });
    await fake.limit("graphql", 60);
    const variables = { input: { pullRequestId: (await fake.pull(5)).id, mergeMethod: "SQUASH" } };
    await fetch(`${fake.url}/graphql`, {
      method: "POST",
      body: JSON.stringify({
        query:
          "mutation Enable($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }",
        variables,
      }),
    });
    expect((await fake.writes()).slice(4)).toEqual([
      { kind: "POST actions/runs/7001/approve", input: {} },
      { kind: "enablePullRequestAutoMerge", input: variables },
    ]);
  } finally {
    fake.stop();
  }
});

test("records a git push before the transport refuses it", () => {
  const git = outsideGit("outside-push-audit");
  const result = git.start(() =>
    NodeChildProcess.spawnSync("git", ["push", "origin", "HEAD"], { stdio: "ignore" }),
  );
  expect(result.status).toBe(1);
  expect(git.pushes()).toEqual([["push", "origin", "HEAD"]]);
});
