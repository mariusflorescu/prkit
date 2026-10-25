import { AccountId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { FingerprintResponse, fingerprintQuery } from "../pullRequests/fingerprint.ts";
import { makeTimelineRead } from "../pullRequests/timelineRead.ts";
import { GitHubApi, layer } from "./GitHubApi.ts";

// What the server log says about GitHub requests. Which account read what, and an answer
// GitHub changed under prkit, are hard to see from the UI and must never need a debugger.
const OCTOCAT = AccountId.make("github.com/octocat");
const account = {
  id: OCTOCAT,
  host: "github.com",
  login: "octocat",
  name: null,
  avatarUrl: null,
  configDir: "/home/octocat/.config/gh",
  status: { _tag: "ready" },
} as const;
const unused = Effect.die("not used by GitHubApi");
const accounts = Layer.succeed(
  GitHubAccounts,
  GitHubAccounts.of({
    list: () => unused,
    known: unused,
    changes: Stream.empty,
    configured: unused,
    refresh: () => unused,
    addConfigDir: () => unused,
    removeConfigDir: () => unused,
    token: () => Effect.succeed({ account, token: Redacted.make("not-a-token") }),
    apiBase: () => "https://api.github.test",
  }),
);

/** GitHub answering each request with the next of `answers`, in order. */
const github = (answers: ReadonlyArray<{ readonly status: number; readonly body: string }>) => {
  const queue = [...answers];
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const answer = queue.shift() ?? { status: 500, body: "" };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(answer.body, {
            status: answer.status,
            headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
          }),
        ),
      );
    }),
  );
};

/** Runs `effect` against `answers` and returns every Info and Warning line it logged. */
const logsOf = <A, E>(
  answers: ReadonlyArray<{ readonly status: number; readonly body: string }>,
  effect: Effect.Effect<A, E, GitHubApi>,
) => {
  const lines: Array<{
    readonly level: string;
    readonly message: string;
    readonly annotations: Record<string, string | number>;
  }> = [];
  const capture = Logger.map(Logger.formatStructured, (line) => {
    lines.push({
      level: line.level,
      message: String(line.message),
      annotations: Object.fromEntries(
        Object.entries(line.annotations).map(([key, value]) => [
          key,
          typeof value === "number" ? value : String(value),
        ]),
      ),
    });
  });
  return Effect.runPromise(
    effect.pipe(
      Effect.ignore,
      Effect.provide(
        Layer.mergeAll(
          layer.pipe(Layer.provide([accounts, github(answers)])),
          Logger.layer([capture]),
        ),
      ),
      Effect.as(lines),
    ),
  );
};

const fingerprint = {
  title: "Count clicks",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-10-11T10:00:00Z",
  headRefOid: "0fb0d774fe3716d1dfb9ea6c6305de8c4e7ec09d",
  baseRefOid: "ab30ea7c8beec5a220e2b0f925d751574aea0d7b",
  baseRefName: "main",
  reviewDecision: null,
  mergeStateStatus: "CLEAN",
  comments: { totalCount: 2 },
  reviews: { totalCount: 1 },
  stack: null,
  stackEntry: null,
};
const answer = (pullRequest: Record<string, string | number | boolean | null | object>) => ({
  status: 200,
  body: JSON.stringify({ data: { prkitRateLimit: { cost: 1 }, p0: { pullRequest } } }),
});
const readPull = (number: number) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const { query, variables } = fingerprintQuery([
      { host: "github.com", owner: "acme", repo: "widgets", number },
    ]);
    return yield* api.graphqlResult(OCTOCAT, query, variables, FingerprintResponse);
  });
const readFingerprint = readPull(1);

describe("GitHubApi logs", () => {
  it("names the account, operation, status and cost of every request", async () => {
    const lines = await logsOf(
      [
        { status: 200, body: JSON.stringify({ number: 1 }) },
        { status: 404, body: JSON.stringify({ message: "Not Found" }) },
        answer(fingerprint),
      ],
      Effect.gen(function* () {
        const api = yield* GitHubApi;
        const Pull = Schema.Struct({ number: Schema.Int });
        yield* api.rest(OCTOCAT, "/repos/acme/widgets/pulls/1", Pull);
        yield* api.rest(OCTOCAT, "/repos/acme/widgets/pulls/2", Pull).pipe(Effect.ignore);
        yield* readFingerprint;
      }),
    );
    expect(lines.filter((line) => line.message === "GitHub request")).toEqual([
      {
        level: "INFO",
        message: "GitHub request",
        annotations: {
          accountId: "github.com/octocat",
          operation: "GET /repos/acme/widgets/pulls/1",
          status: 200,
          cost: 1,
          priority: "interactive",
        },
      },
      {
        level: "INFO",
        message: "GitHub request",
        annotations: {
          accountId: "github.com/octocat",
          operation: "GET /repos/acme/widgets/pulls/2",
          status: 404,
          cost: 1,
          priority: "interactive",
        },
      },
      {
        level: "INFO",
        message: "GitHub request",
        annotations: {
          accountId: "github.com/octocat",
          operation: "PrkitWatch",
          status: 200,
          cost: 1,
          priority: "interactive",
        },
      },
    ]);
  });

  it("warns once when the fingerprint stops decoding, and says once when it reads again", async () => {
    const malformed = answer({ ...fingerprint, headRefOid: 42 });
    const lines = await logsOf(
      [malformed, malformed, answer(fingerprint), answer(fingerprint)],
      Effect.gen(function* () {
        for (let tick = 0; tick < 4; tick++) yield* readFingerprint.pipe(Effect.ignore);
      }),
    );
    expect(lines.filter((line) => line.message !== "GitHub request")).toEqual([
      {
        level: "WARN",
        message: "GitHub sent an answer prkit can't read",
        annotations: {
          accountId: "github.com/octocat",
          operation: "PrkitWatch",
          path: "p0.pullRequest.headRefOid",
          problem: "Expected string",
        },
      },
      {
        level: "INFO",
        message: "GitHub's answer reads again",
        annotations: { accountId: "github.com/octocat", operation: "PrkitWatch" },
      },
    ]);
  });

  it("keeps a batch that reads apart from one that doesn't", async () => {
    const malformed = answer({ ...fingerprint, headRefOid: 42 });
    const lines = await logsOf(
      [malformed, answer(fingerprint), malformed, answer(fingerprint), malformed],
      Effect.gen(function* () {
        for (let tick = 0; tick < 2; tick++) {
          yield* readPull(1).pipe(Effect.ignore);
          yield* readPull(2).pipe(Effect.ignore);
        }
        yield* readPull(1).pipe(Effect.ignore);
      }),
    );
    expect(lines.filter((line) => line.message !== "GitHub request")).toEqual([
      {
        level: "WARN",
        message: "GitHub sent an answer prkit can't read",
        annotations: {
          accountId: "github.com/octocat",
          operation: "PrkitWatch",
          path: "p0.pullRequest.headRefOid",
          problem: "Expected string",
        },
      },
    ]);
  });

  it("keeps apart timelines whose query carries the pull request, and leaves withheld items to the timeline's own line", async () => {
    const timeline = (pageInfo: object, errors: ReadonlyArray<object> = []) => ({
      status: 200,
      body: JSON.stringify({
        data: {
          prkitRateLimit: { cost: 1 },
          repository: { pullRequest: { timelineItems: { nodes: [null], pageInfo } } },
        },
        errors,
      }),
    });
    const broken = timeline({ hasNextPage: "no", endCursor: null });
    const withheld = timeline({ hasNextPage: false, endCursor: null }, [
      {
        type: "FORBIDDEN",
        path: ["repository", "pullRequest", "timelineItems", "nodes", 0],
        message: "Resource protected by organization SAML enforcement.",
      },
    ]);
    const lines = await logsOf(
      [broken, withheld, broken, withheld, broken],
      Effect.gen(function* () {
        const readTimeline = yield* makeTimelineRead;
        const read = (number: number) =>
          readTimeline(OCTOCAT, { host: "github.com", owner: "acme", repo: "widgets", number });
        for (let tick = 0; tick < 2; tick++) {
          yield* read(1).pipe(Effect.ignore);
          yield* read(2).pipe(Effect.ignore);
        }
        yield* read(1).pipe(Effect.ignore);
      }),
    );
    const timelineLine = {
      level: "WARN",
      message: "GitHub withheld or prkit couldn't read some timeline items",
      annotations: {
        accountId: "github.com/octocat",
        prUrl: "https://github.com/acme/widgets/pull/2",
        itemErrors: 1,
        unreadable: "",
      },
    };
    expect(lines.filter((line) => line.message !== "GitHub request")).toEqual([
      {
        level: "WARN",
        message: "GitHub sent an answer prkit can't read",
        annotations: {
          accountId: "github.com/octocat",
          operation: "PrkitTimeline",
          path: "repository.pullRequest.timelineItems.pageInfo.hasNextPage",
          problem: "Expected boolean",
        },
      },
      timelineLine,
      timelineLine,
    ]);
  });
});

describe("GitHubApi partial answers", () => {
  it("fails in GitHub's words when GitHub's errors explain the hole prkit can't read", async () => {
    const failure = (errors: ReadonlyArray<object>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* GitHubApi;
          return yield* api.graphql(
            OCTOCAT,
            "query PrkitLabels { pullRequest { labels { totalCount } } }",
            Schema.Struct({
              pullRequest: Schema.Struct({ labels: Schema.Struct({ totalCount: Schema.Int }) }),
            }),
          );
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
          Effect.provide(
            layer.pipe(
              Layer.provide([
                accounts,
                github([
                  {
                    status: 200,
                    body: JSON.stringify({
                      data: { prkitRateLimit: { cost: 1 }, pullRequest: { labels: null } },
                      errors,
                    }),
                  },
                ]),
              ]),
            ),
          ),
        ),
      );
    expect(
      await failure([
        { type: "FORBIDDEN", path: ["pullRequest", "labels"], message: "Labels are hidden." },
      ]),
    ).toBe("GitHub couldn't complete the query. Labels are hidden.");
    expect(await failure([])).toBe("GitHub returned an unreadable response. Try refreshing.");
  });
});
