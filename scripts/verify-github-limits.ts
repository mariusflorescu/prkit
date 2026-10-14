import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp2 from "node:http2";
import * as NodePath from "node:path";

import { AccountId, PullRequestKey, type Account } from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../apps/server/src/accounts/GitHubAccounts.ts";
import * as GitHubApi from "../apps/server/src/github/GitHubApi.ts";
import * as GitHubHttpClient from "../apps/server/src/github/httpClient.ts";
import * as NodeSqliteClient from "../apps/server/src/persistence/NodeSqliteClient.ts";
import createWorkspace from "../apps/server/src/persistence/Migrations/003_Workspace.ts";
import createActionPreferences from "../apps/server/src/persistence/Migrations/006_PullRequestActions.ts";
import createReadCache from "../apps/server/src/persistence/Migrations/010_GitHubReadCache.ts";
import { makeDetailReads } from "../apps/server/src/pullRequests/detailReads.ts";
import { makeActions } from "../apps/server/src/pullRequests/actions.ts";
import { makeReadCache } from "../apps/server/src/pullRequests/readCache.ts";

const certDir = process.argv[2];
if (certDir === undefined)
  throw new Error(
    "Pass the directory containing local key.pem and cert.pem. Trust cert.pem with NODE_EXTRA_CA_CERTS for this process.",
  );
const protocols = new Set<string>();
let scenario = "transport";
let pageReads = 0;
let timelinePages = 0;
let threadPages = 0;
let threadHead = "head";
let candidatePages = 0;
// GitHub's rate limit headers on every answer, and which resource answers "limit used up".
const quota = { remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 };
let limited: "none" | "graphql" | "rest" = "none";
let requests = 0;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeQuery = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
);
const pull = {
  title: "Local pagination journey",
  body: null,
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  user: null,
  head: { ref: "feature", sha: "head" },
  base: { ref: "main", sha: "base" },
  requested_reviewers: [],
  requested_teams: [],
  labels: [],
  additions: 3001,
  deletions: 0,
  changed_files: 3001,
  html_url: "https://github.com/limits/example/pull/1",
  created_at: "2026-10-11T00:00:00Z",
  updated_at: "2026-10-11T00:00:00Z",
};
const comment = {
  id: 1,
  user: null,
  body: "Local comment",
  created_at: pull.created_at,
  html_url: pull.html_url,
};
const review = {
  id: 1,
  user: null,
  body: "Local review",
  state: "APPROVED",
  html_url: pull.html_url,
};
const status = { id: 1, context: "local", state: "success", target_url: null };
const check = { id: 1, name: "local", status: "completed", conclusion: "success", html_url: null };
const server = NodeHttp2.createSecureServer({
  key: NodeFS.readFileSync(NodePath.join(certDir, "key.pem")),
  cert: NodeFS.readFileSync(NodePath.join(certDir, "cert.pem")),
  allowHTTP1: true,
});
server.on("request", (request, response) => {
  protocols.add(request.httpVersion);
  requests++;
  response.setHeader("x-ratelimit-limit", "5000");
  response.setHeader("x-ratelimit-remaining", String(limited === "none" ? quota.remaining : 0));
  response.setHeader("x-ratelimit-reset", String(quota.reset));
  const url = new URL(request.url ?? "/", "https://localhost");
  if (url.pathname === "/graphql") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const { query } = decodeQuery(body);
      response.setHeader("content-type", "application/json");
      if (limited === "graphql") {
        response.end(
          '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}',
        );
      } else if (query.includes("assignableUsers")) {
        candidatePages++;
        response.end(
          encodeJson({
            data: {
              repository: {
                assignableUsers: {
                  nodes: [],
                  pageInfo: {
                    hasNextPage: scenario.startsWith("candidate-users"),
                    endCursor:
                      scenario === "candidate-users-cycle" ? "same" : String(candidatePages),
                  },
                },
              },
            },
          }),
        );
      } else if (query.includes("reviewThreads")) {
        threadPages++;
        const data = encodeJson({
          data: {
            repository: {
              pullRequest: {
                headRefOid: threadHead,
                reviewThreads: {
                  nodes: [],
                  pageInfo: {
                    hasNextPage: scenario === "threads-limit" || scenario === "threads-slow",
                    endCursor: String(threadPages),
                  },
                },
              },
            },
          },
        });
        if (scenario === "threads-slow") setTimeout(() => response.end(data), 6000);
        else response.end(data);
      } else if (query.includes("timelineItems")) {
        timelinePages++;
        const cursor =
          scenario === "timeline-cycle"
            ? timelinePages % 2 === 1
              ? "a"
              : "b"
            : String(timelinePages);
        response.end(
          encodeJson({
            data: {
              repository: {
                pullRequest: {
                  timelineItems: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: cursor },
                  },
                },
              },
            },
          }),
        );
      } else
        response.end(
          query.includes("reviewDecision")
            ? encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: true,
                    rebaseMergeAllowed: true,
                    autoMergeAllowed: false,
                    isArchived: false,
                    viewerPermission: scenario === "candidate-teams" ? "WRITE" : "READ",
                    viewerDefaultMergeMethod: "MERGE",
                    pullRequest: {
                      id: "local-pull",
                      headRefName: "feature",
                      baseRefName: "main",
                      headRef: null,
                      reviewDecision: null,
                      mergeStateStatus: "CLEAN",
                      isMergeQueueEnabled: false,
                      isCrossRepository: false,
                      viewerCanUpdate: false,
                      viewerCanUpdateBranch: false,
                      viewerCanClose: false,
                      viewerCanReopen: false,
                      viewerCanLabel: false,
                      viewerCanAssign: false,
                      viewerCanEnableAutoMerge: false,
                      viewerCanDisableAutoMerge: false,
                      autoMergeRequest: null,
                      baseRef: null,
                      mergeTitle: "Local merge",
                      mergeBody: "",
                      squashTitle: "Local squash",
                      squashBody: "",
                      commits: { nodes: [] },
                    },
                  },
                },
              })
            : query.includes("prkitRateLimit")
              ? '{"data":{"ok":true,"prkitRateLimit":{"cost":3}}}'
              : '{"data":{"ok":true}}',
        );
    });
    return;
  }
  request.resume();
  if (limited === "rest") {
    response.writeHead(403, { "content-type": "application/json" });
    response.end('{"message":"API rate limit exceeded for user ID 1."}');
    return;
  }
  if (url.pathname === "/stall") {
    response.writeHead(200);
    response.write('{"ok":');
    return;
  }
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/oversized") {
    response.end(`{"data":"${"x".repeat(17 * 1024 * 1024)}"}`);
    return;
  }
  if (url.pathname === "/repos/limits/example/pulls/1") {
    response.end(encodeJson(pull));
    return;
  }
  const endless =
    (scenario === "comments" && url.pathname.endsWith("/issues/1/comments")) ||
    (scenario === "inline" && url.pathname.endsWith("/pulls/1/comments")) ||
    (scenario === "reviews" && url.pathname.endsWith("/reviews")) ||
    (scenario === "statuses" && url.pathname.endsWith("/statuses")) ||
    (scenario === "checks" && url.pathname.endsWith("/check-runs")) ||
    (scenario === "candidate-labels" && url.pathname.endsWith("/labels")) ||
    (scenario === "candidate-teams" && url.pathname.endsWith("/teams")) ||
    (scenario === "files" && url.pathname.endsWith("/files"));
  if (endless) pageReads++;
  const rows = endless
    ? Array.from({ length: 100 }, (_, index) =>
        url.pathname.endsWith("/files")
          ? {
              filename: `file-${url.searchParams.get("page")}-${index}.ts`,
              status: "added",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+added",
            }
          : url.pathname.endsWith("/labels")
            ? { name: "local", color: "abcdef" }
            : url.pathname.endsWith("/teams")
              ? { name: "local", slug: "local" }
              : url.pathname.endsWith("/reviews")
                ? review
                : url.pathname.endsWith("/statuses")
                  ? status
                  : url.pathname.endsWith("/check-runs")
                    ? check
                    : comment,
      )
    : [];
  response.end(
    url.pathname.endsWith("/check-runs")
      ? encodeJson({ check_runs: rows })
      : url.pathname.startsWith("/repos/")
        ? encodeJson(rows)
        : '{"ok":true}',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string")
  throw new Error("Local HTTPS server has no port.");
const origin = `https://localhost:${address.port}`;
const account: Account = {
  id: AccountId.make("github.com/limits-test"),
  host: "github.com",
  login: "limits-test",
  name: null,
  avatarUrl: null,
  configDir: "/isolated-test",
  status: { _tag: "ready" },
};
const accounts = GitHubAccounts.of({
  list: () => Effect.succeed({ accounts: [account], addedConfigDirs: [] }),
  refresh: () => Effect.succeed({ accounts: [account], addedConfigDirs: [] }),
  known: Effect.succeed({ accounts: [account], addedConfigDirs: [] }),
  token: () => Effect.succeed({ account, token: Redacted.make("local-test-token") }),
  apiBase: () => "https://api.github.com",
  addConfigDir: () => Effect.die("Not used in the limits journey"),
  removeConfigDir: () => Effect.die("Not used in the limits journey"),
});
const Ok = Schema.Struct({ ok: Schema.Boolean });
const StringJson = Schema.fromJsonString(Schema.String);
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createWorkspace;
      yield* createActionPreferences;
      yield* createReadCache;
      const http = yield* HttpClient.HttpClient;
      const routed = HttpClient.mapRequest(http, (request) =>
        HttpClientRequest.setUrl(
          request,
          `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`,
        ),
      );
      const api = yield* GitHubApi.make.pipe(
        Effect.provideService(HttpClient.HttpClient, routed),
        Effect.provideService(GitHubAccounts, accounts),
      );
      for (let index = 0; index < 12; index++) {
        NodeAssert.deepEqual(yield* api.graphql(account.id, "query { viewer { login } }", Ok), {
          ok: true,
        });
        NodeAssert.deepEqual(yield* api.rest(account.id, "/ok", Ok), { ok: true });
      }
      NodeAssert.deepEqual([...protocols], ["1.1"]);
      process.stdout.write("PASS HTTPS POSTs negotiate HTTP/1.1 even when the server offers h2\n");
      const oversized = yield* api
        .rest(account.id, "/oversized", Schema.Struct({ data: Schema.String }))
        .pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(oversized), true);
      if (Result.isFailure(oversized))
        NodeAssert.equal(
          oversized.failure.message,
          "GitHub returned more data than prkit can safely read. Open the pull request on GitHub.",
        );
      process.stdout.write("PASS oversized HTTP bodies fail before JSON parsing\n");
      const before = performance.now();
      const stalled = yield* Effect.forEach(
        [1, 2, 3, 4, 5],
        () => api.rest(account.id, "/stall", Ok).pipe(Effect.uninterruptible, Effect.result),
        { concurrency: "unbounded" },
      );
      for (const result of stalled) {
        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result))
          NodeAssert.equal(
            result.failure.message,
            "GitHub took too long to respond. Try refreshing.",
          );
      }
      NodeAssert.ok(performance.now() - before < 32_000);
      NodeAssert.deepEqual(yield* api.rest(account.id, "/ok", Ok), { ok: true });
      process.stdout.write(
        "PASS five stalled or queued reads time out together and a later read succeeds\n",
      );
      const limits = AccountId.make("github.com/limits-budget");
      const query = "query { viewer { login } }";
      NodeAssert.deepEqual(yield* api.graphql(limits, query, Ok), { ok: true });
      const graphqlLimit = (yield* api.budget).accounts
        .find((row) => row.accountId === limits)
        ?.limits.find((limit) => limit.resource === "graphql");
      NodeAssert.equal(graphqlLimit?.spentLastHour, 3);
      NodeAssert.equal(graphqlLimit?.remaining, 5000);
      process.stdout.write(
        "PASS GraphQL spend is GitHub's own cost figure, and headers are kept\n",
      );
      quota.remaining = 400;
      yield* api.graphql(limits, query, Ok);
      let sent = requests;
      const reserved = yield* GitHubApi.inBackground(api.graphql(limits, query, Ok)).pipe(
        Effect.result,
      );
      NodeAssert.equal(Result.isFailure(reserved) && reserved.failure.reason, "reserved");
      NodeAssert.equal(requests, sent);
      NodeAssert.deepEqual(yield* api.graphql(limits, query, Ok), { ok: true });
      NodeAssert.equal(requests, sent + 1);
      process.stdout.write(
        "PASS under 10% left, background reads send nothing and a click still goes\n",
      );
      quota.reset = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 120;
      limited = "graphql";
      const refused = yield* api.graphql(limits, query, Ok).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(refused) && refused.failure.reason, "rate-limited");
      NodeAssert.equal(Result.isFailure(refused) && refused.failure.resetAt, quota.reset * 1000);
      sent = requests;
      for (let index = 0; index < 3; index++) {
        const paused = yield* api.graphql(limits, query, Ok).pipe(Effect.result);
        NodeAssert.equal(Result.isFailure(paused) && paused.failure.reason, "rate-limited");
      }
      NodeAssert.equal(requests, sent);
      NodeAssert.deepEqual(yield* api.rest(limits, "/ok", Ok), { ok: true });
      limited = "rest";
      const restRefused = yield* api.rest(limits, "/ok", Ok).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(restRefused) && restRefused.failure.reason, "rate-limited");
      sent = requests;
      const restPaused = yield* api.rest(limits, "/ok", Ok).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(restPaused) && restPaused.failure.reason, "rate-limited");
      NodeAssert.equal(requests, sent);
      limited = "none";
      quota.remaining = 5000;
      process.stdout.write(
        "PASS a 200 RATE_LIMITED or a 403 limit pauses that resource: nothing is sent until the reset\n",
      );
      const reads = yield* makeDetailReads({
        changed: () => Effect.void,
        stackChanged: () => Effect.void,
      }).pipe(
        Effect.provideService(GitHubApi.GitHubApi, api),
        Effect.provideService(GitHubAccounts, accounts),
      );
      const key = PullRequestKey.make("github.com/limits/example#1");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO open_pull_requests (key, account_id, position) VALUES (${key}, ${account.id}, 0)`;
      for (const name of ["comments", "inline", "reviews", "statuses", "checks"]) {
        scenario = name;
        pageReads = 0;
        const result = yield* reads.current(key, account.id).pipe(Effect.result);
        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result))
          NodeAssert.equal(
            result.failure.message,
            name === "checks"
              ? "This pull request has too many checks to load safely. Open it on GitHub."
              : "This pull request has too many comments, reviews, or statuses to load safely. Open it on GitHub.",
          );
        NodeAssert.equal(pageReads, 30);
      }
      scenario = "files";
      pageReads = 0;
      const files = yield* reads.files(key, account.id);
      NodeAssert.equal(files.files.length, 3000);
      NodeAssert.equal(files.changedFiles, 3001);
      NodeAssert.equal(pageReads, 30);
      for (const name of ["timeline-cycle", "timeline-limit"]) {
        scenario = name;
        timelinePages = 0;
        const result = yield* reads.timeline(key, account.id).pipe(Effect.result);
        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result))
          NodeAssert.equal(
            result.failure.message,
            "GitHub couldn't load the rest of this timeline safely. Open it on GitHub.",
          );
        NodeAssert.equal(timelinePages, name === "timeline-cycle" ? 3 : 30);
      }
      scenario = "transport";
      NodeAssert.equal((yield* reads.current(key, account.id)).title, "Local pagination journey");
      process.stdout.write(
        "PASS endless REST pages and cycling or endless timeline cursors fail safely; 3,000-file truncation and later detail reads still work\n",
      );
      pull.title = "Changed after an action";
      NodeAssert.equal((yield* reads.detail(key, account.id)).title, "Local pagination journey");
      yield* reads.invalidate(key, account.id);
      NodeAssert.equal((yield* reads.detail(key, account.id)).title, "Changed after an action");
      process.stdout.write("PASS action invalidation refreshes the account-bound detail cache\n");
      const actions = yield* makeActions(reads).pipe(
        Effect.provideService(GitHubApi.GitHubApi, api),
      );
      for (const name of [
        "candidate-users-cycle",
        "candidate-users-limit",
        "candidate-labels",
        "candidate-teams",
      ]) {
        scenario = name;
        pageReads = 0;
        candidatePages = 0;
        yield* reads.invalidate(key, account.id);
        const result = yield* actions.candidates(key, account.id).pipe(Effect.result);
        NodeAssert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result))
          NodeAssert.equal(
            result.failure.message,
            "GitHub couldn't load all action choices safely. Open the pull request on GitHub.",
          );
        NodeAssert.equal(
          name.startsWith("candidate-users") ? candidatePages : pageReads,
          name === "candidate-users-cycle" ? 2 : 30,
        );
      }
      scenario = "transport";
      yield* reads.invalidate(key, account.id);
      NodeAssert.deepEqual(yield* actions.candidates(key, account.id), {
        reviewers: [],
        teams: [],
        labels: [],
      });
      process.stdout.write(
        "PASS action choices reject cursor cycles and endless reviewer, label or team pages; a later read succeeds\n",
      );
      NodeAssert.equal((yield* reads.threads(key, account.id)).headSha, "head");
      threadHead = "updated-head";
      NodeAssert.equal((yield* reads.threads(key, account.id)).headSha, "head");
      yield* reads.invalidate(key, account.id);
      NodeAssert.equal((yield* reads.threads(key, account.id)).headSha, "updated-head");
      scenario = "threads-limit";
      threadPages = 0;
      yield* reads.invalidate(key, account.id);
      NodeAssert.equal((yield* reads.threads(key, account.id)).truncated, true);
      NodeAssert.equal(threadPages, 10);
      scenario = "threads-slow";
      yield* reads.invalidate(key, account.id);
      const slowThreads = yield* reads.threads(key, account.id).pipe(Effect.result);
      NodeAssert.equal(Result.isFailure(slowThreads), true);
      if (Result.isFailure(slowThreads))
        NodeAssert.equal(
          slowThreads.failure.message,
          "GitHub took too long to load review comments. Try refreshing.",
        );
      scenario = "transport";
      threadHead = "recovered-head";
      yield* reads.invalidate(key, account.id);
      NodeAssert.equal((yield* reads.threads(key, account.id)).headSha, "recovered-head");
      process.stdout.write(
        "PASS review threads invalidate, truncate at ten pages, time out across slow pages and recover\n",
      );
      const cacheKey = (name: string) => ({
        accountId: account.id,
        configDir: "/isolated-test",
        key: name,
      });
      const answer = (value: string) => Effect.succeed(value);
      const cache = yield* makeReadCache({
        name: "limits-test",
        json: StringJson,
        maxEntries: 2,
        maxBytes: 24,
        freshMs: 100,
        persist: false,
        changed: () => Effect.void,
      });
      yield* cache.read(cacheKey("a"), answer("alpha"));
      yield* cache.read(cacheKey("b"), answer("beta"));
      yield* cache.read(cacheKey("c"), answer("gamma"));
      NodeAssert.equal(yield* cache.peek(cacheKey("b")), undefined);
      NodeAssert.equal((yield* cache.peek(cacheKey("c")))?.value, "gamma");
      yield* cache.read(cacheKey("oversized"), answer("This value exceeds the budget"));
      NodeAssert.equal(yield* cache.peek(cacheKey("oversized")), undefined);
      NodeAssert.equal((yield* cache.peek(cacheKey("c")))?.value, "gamma");
      NodeAssert.equal((yield* cache.read(cacheKey("c"), answer("unused"))).value, "gamma");
      yield* Effect.sleep("125 millis");
      NodeAssert.equal((yield* cache.read(cacheKey("c"), answer("gamma 2"))).value, "gamma");
      yield* Effect.sleep("25 millis");
      NodeAssert.equal((yield* cache.peek(cacheKey("c")))?.value, "gamma 2");
      const entries = yield* makeReadCache({
        name: "entry-limits-test",
        json: StringJson,
        maxEntries: 2,
        maxBytes: 1024,
        freshMs: 1000,
        persist: false,
        changed: () => Effect.void,
      });
      yield* entries.read(cacheKey("a"), answer("alpha"));
      yield* entries.read(cacheKey("b"), answer("beta"));
      NodeAssert.equal((yield* entries.peek(cacheKey("a")))?.value, "alpha");
      yield* entries.read(cacheKey("c"), answer("gamma"));
      NodeAssert.equal(yield* entries.peek(cacheKey("b")), undefined);
      NodeAssert.equal((yield* entries.peek(cacheKey("a")))?.value, "alpha");
      NodeAssert.equal((yield* entries.peek(cacheKey("c")))?.value, "gamma");
      process.stdout.write(
        "PASS cache byte budget, entry budget and oversized values hold; a stale answer comes back at once and is read again in the background\n",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(GitHubHttpClient.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
