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

test("audits GraphQL GET mutations and unsupported methods before refusing them", async () => {
  const fake = await startFakeGitHub("outside-graphql-methods");
  const get = (query: string, operationName?: string) => {
    const url = new URL("/graphql", fake.url);
    url.searchParams.set("query", query);
    if (operationName !== undefined) url.searchParams.set("operationName", operationName);
    return fetch(url);
  };
  try {
    await get("query Read { viewer { login } }", "Read");
    expect(await fake.writes()).toEqual([]);
    await get("mutation{x}");
    await get("mutation R { x }", "R");
    await fetch(`${fake.url}/graphql`, { method: "PUT", body: '{"query":"query Read { x }"}' });
    await fetch(`${fake.url}/graphql?operationName=Read`);
    await fake.limit("graphql", 60);
    await get("mutation{x}");
    expect((await fake.writes()).map((entry) => entry.kind)).toEqual([
      "graphql mutation",
      "graphql mutation",
      "graphql unclassified",
      "graphql unclassified",
      "graphql mutation",
    ]);
  } finally {
    fake.stop();
  }
});

test("audits every GraphQL batch entry and records anything it cannot classify as a query", async () => {
  const fake = await startFakeGitHub("outside-graphql-audit");
  const post = (body: string) => fetch(`${fake.url}/graphql`, { method: "POST", body });
  try {
    for (const query of [
      "query Read { viewer { login } }",
      "{ viewer { login } }",
      'query Read { mutation(text: "mutation Fake { x }") }',
      "# mutation in a comment\nquery Read { viewer { login } }",
      "fragment User on User { login } query Read { viewer { ...User } }",
    ])
      await post(JSON.stringify({ query }));
    expect(await fake.writes()).toEqual([]);

    await post(
      JSON.stringify([
        { operationName: "Read", query: "query Read { viewer { login } }" },
        { operationName: "R", query: "mutation R { x }" },
        { query: "query MissingClosingBrace { viewer" },
        { variables: {} },
      ]),
    );
    await post("{malformed");
    await post("[]");
    await post(JSON.stringify({ query: "subscription Updates { changed }" }));
    await post(JSON.stringify({ query: "query Read { viewer { login } }", variables: 42 }));
    await fake.limit("graphql", 60);
    await post(JSON.stringify([{ operationName: "R", query: "mutation R { x }" }]));
    expect((await fake.writes()).map((entry) => entry.kind)).toEqual([
      "graphql mutation",
      "graphql unclassified",
      "graphql unclassified",
      "graphql unclassified",
      "graphql unclassified",
      "graphql unclassified",
      "graphql unclassified",
      "graphql mutation",
    ]);
  } finally {
    fake.stop();
  }
});
