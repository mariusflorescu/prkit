/**
 * A local fake GitHub for budget checks: it answers the reads prkit makes for one
 * account (`budget-test`) and seven PRs in `budget/fixtures`, sends GitHub's rate limit
 * headers, and counts every request and GraphQL point. No real token or network.
 * PRs 1-6 are the account's own and in its inbox; PR 7 comes from a fork by an
 * outside author and is opened by its URL. PR 8, also opened by its URL, has a history
 * of label, reviewer, title, assignee, base branch, reference and state events by
 * several people, at fixed times, and one mention from a repository the account can't
 * see, which comes back as a null node and a FORBIDDEN error like GitHub's. PR 9, opened
 * by its URL too, changes one file in one hunk of context, a deletion and two additions.
 *
 * A timeline query gets only the `itemTypes` it asks for and only the fields it
 * selects, and fails like GitHub's on a fragment on a type it doesn't know or one that
 * can't be spread where it is (`... on Team` inside `assignee`).
 *
 * The repository allows auto-merge; `require` makes a PR's base require the `build`
 * check and starts it running, so the PR is BLOCKED until it completes, and with
 * auto-merge enabled it merges then. PR 7 takes reviews, and its head has one fork
 * workflow run waiting for approval. Every write prkit sends is kept for `writes`.
 *
 *   node scripts/fake-github.ts --home <dir> [--port 0] [--no-stacks] [--second-account]
 *
 * PRs 1 and 2 are the two layers of stack 900. `--no-stacks` answers like GitHub
 * Enterprise Server instead: a query that asks for stacks fails as `undefinedField`.
 * The account also sees `budget/tools`, whose one open PR (#1) needs nobody, so it is
 * in no inbox search, and an archived `budget/attic` that lists leave out.
 *
 * `--home` gets `.config/gh/hosts.yml` and a `gh` that prints a fake token for the login
 * in `$GH_CONFIG_DIR/hosts.yml`; pass it to `verify-app start --github-api <url> --gh-home <dir>`.
 * `--second-account` adds `.config/gh-second` for `budget-second`, which sees the same pull
 * requests. `/user` answers for any `budget-` login and refuses any other token like GitHub
 * refuses an expired one (401). The ready line on stdout is
 * `{"type":"ready","url":"http://127.0.0.1:<port>"}`; `<home>/fake.json` records the
 * same url and this pid. Control, all under `/__fake/`:
 *
 *   GET  stats                          counts by kind, GraphQL points, requests while limited
 *   POST reset-stats
 *   POST comment?pr=<n>                 a new issue comment (bumps updatedAt)
 *   POST push?pr=<n>                    a new head commit (bumps updatedAt)
 *   POST git-head?pr=<n>&sha=<sha>      a local commit is its one head (bumps updatedAt)
 *   POST files?pr=<n>                   its files answer from then on: the JSON list of files in the body
 *   POST checks?pr=<n>&status=<s>       check run status: queued, in_progress or completed
 *   POST conflict?pr=<n>                the base moved under it: mergeable false, DIRTY
 *   POST checking?pr=<n>                GitHub is still working out mergeability: mergeable null, UNKNOWN
 *   POST require?pr=<n>                 its base requires the `build` check, which starts running
 *   POST merge?pr=<n>                   merged on GitHub; inbox searches still find it for 15 seconds
 *   POST close?pr=<n>                   closed on GitHub without a merge; the account may reopen it
 *   POST draft?pr=<n>                   converted to a draft
 *   POST behind?pr=<n>&by=<k>           its base gained k commits, so Update branch applies
 *   GET  pull?pr=<n>                    its node id, head sha and workflow run ids, for assertions
 *   GET  writes                         every mutation and REST write, with its input
 *   POST limit?resource=graphql|core&seconds=<s>   the limit is used up until then
 *   POST latency?ms=<n>[&resource=graphql|core]   every API answer, or that resource's, waits this long
 *   POST archive?repo=<name>            archives a repository, so lists leave it out
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { graphql } from "./fake-github/graphql.ts";
import {
  archived,
  encodeJson,
  head,
  iso,
  LOGIN,
  merge,
  mergeState,
  nodeId,
  pulls,
  resetStats,
  SECOND_LOGIN,
  servedFiles,
  sha,
  stats,
  writes,
} from "./fake-github/model.ts";
import { home, values } from "./fake-github/options.ts";
import { recordGraphqlAttempt, recordRestAttempt } from "./fake-github/writeAttempts.ts";
import { rest } from "./fake-github/rest.ts";

const LIMIT = 5000;
const decodeFiles = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        status: Schema.String,
        additions: Schema.Int,
        deletions: Schema.Int,
        patch: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);
let nextComment = 10_000;
/** Rate limit state per resource, like GitHub's own windows. */
const quotas = {
  core: { used: 0, reset: Math.floor(Date.now() / 1000) + 3600, limitedUntil: 0 },
  graphql: { used: 0, reset: Math.floor(Date.now() / 1000) + 3600, limitedUntil: 0 },
};
type Resource = keyof typeof quotas;
const latency: Record<Resource, number> = { core: 0, graphql: 0 };

const remaining = (resource: Resource) =>
  Date.now() < quotas[resource].limitedUntil ? 0 : Math.max(0, LIMIT - quotas[resource].used);

const count = (kind: string, status: number, cost: number) => {
  stats.requests++;
  if (kind.startsWith("graphql")) stats.points += cost;
  else stats.rest += cost;
  if (status === 403 || kind.endsWith(":limited")) stats.refused++;
  stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  stats.log.push({ at: iso(Date.now()), kind, status, cost });
  if (stats.log.length > 2000) stats.log.shift();
};

const send = (
  response: NodeHttp.ServerResponse,
  resource: Resource,
  status: number,
  body: string,
  headers: Record<string, string> = {},
) => {
  const quota = quotas[resource];
  const reset =
    Date.now() < quota.limitedUntil ? Math.ceil(quota.limitedUntil / 1000) : quota.reset;
  setTimeout(() => {
    response.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": String(LIMIT),
      "x-ratelimit-remaining": String(remaining(resource)),
      "x-ratelimit-used": String(quota.used),
      "x-ratelimit-reset": String(reset),
      "x-ratelimit-resource": resource,
      ...headers,
    });
    response.end(body);
  }, latency[resource]);
};

const control = (url: URL, method: string, text: string, response: NodeHttp.ServerResponse) => {
  const answer = (body: Schema.Json) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(encodeJson(body));
  };
  const name = url.pathname.slice("/__fake/".length);
  if (method === "GET" && name === "budget")
    return answer({ core: remaining("core"), graphql: remaining("graphql") });
  if (method === "GET" && name === "stats") return answer(stats);
  if (method === "GET" && name === "writes") return answer(writes);
  if (name === "reset-stats") {
    resetStats();
    return answer({ ok: true });
  }
  const pull = pulls.get(Number(url.searchParams.get("pr")));
  const gitHead = url.searchParams.get("sha");
  if (
    name === "git-head" &&
    method === "POST" &&
    pull !== undefined &&
    gitHead !== null &&
    /^[a-f0-9]{40}$/.test(gitHead)
  ) {
    pull.heads = [
      { sha: gitHead, at: pull.heads[0]?.at ?? Date.now(), message: "Local fixture head" },
    ];
    pull.updatedAt = Date.now();
    return answer({ ok: true });
  }
  if (name === "files" && method === "POST" && pull !== undefined) {
    servedFiles.set(pull.number, decodeFiles(text));
    return answer({ ok: true });
  }
  if (name === "comment" && pull !== undefined) {
    const id = nextComment++;
    const size = Math.min(20_000, Math.max(0, Number(url.searchParams.get("size") ?? "0")));
    pull.comments.push({
      id,
      body: size > 0 ? '"\\ 😀\n'.repeat(size) : `Comment ${id} from the fake`,
      at: Date.now(),
    });
    pull.updatedAt = Date.now();
    return answer({ ok: true, id });
  }
  if (name === "push" && pull !== undefined) {
    const commit = {
      sha: sha(`${pull.number}-${pull.heads.length}`),
      at: Date.now(),
      message: `Commit ${pull.heads.length} from the fake`,
    };
    pull.heads.push(commit);
    pull.updatedAt = Date.now();
    return answer({ ok: true, sha: commit.sha });
  }
  if (name === "conflict" && pull !== undefined) {
    pull.conflicting = true;
    return answer({ ok: true });
  }
  if (name === "checking" && pull !== undefined) {
    pull.checking = true;
    return answer({ ok: true });
  }
  if (name === "merge" && pull !== undefined) {
    merge(pull);
    return answer({ ok: true });
  }
  if (name === "close" && pull !== undefined) {
    pull.state = "CLOSED";
    pull.autoMerge = null;
    pull.updatedAt = Date.now();
    return answer({ ok: true });
  }
  if (name === "draft" && pull !== undefined) {
    pull.draft = true;
    pull.updatedAt = Date.now();
    return answer({ ok: true });
  }
  if (name === "behind" && pull !== undefined) {
    pull.behindBy = Number(url.searchParams.get("by") ?? "1");
    return answer({ ok: true });
  }
  if (name === "require" && pull !== undefined) {
    pull.required = true;
    pull.checks = "in_progress";
    return answer({ ok: true });
  }
  if (method === "GET" && name === "pull" && pull !== undefined)
    return answer({ id: nodeId(pull), head: head(pull), runs: pull.runs.map((run) => run.id) });
  if (name === "checks" && pull !== undefined) {
    const status = url.searchParams.get("status");
    if (status === "queued" || status === "in_progress" || status === "completed")
      pull.checks = status;
    if (pull.autoMerge !== null && mergeState(pull) === "CLEAN") merge(pull);
    return answer({ ok: true, checks: pull.checks });
  }
  if (name === "limit") {
    const resource = url.searchParams.get("resource") === "core" ? "core" : "graphql";
    quotas[resource].limitedUntil =
      Date.now() + Number(url.searchParams.get("seconds") ?? "120") * 1000;
    return answer({ ok: true, resource, until: iso(quotas[resource].limitedUntil) });
  }
  if (name === "archive") {
    archived.add(url.searchParams.get("repo") ?? "");
    return answer({ ok: true, archived: [...archived] });
  }
  if (name === "latency") {
    const only = url.searchParams.get("resource");
    for (const resource of ["core", "graphql"] as const)
      if (only === null || only === resource)
        latency[resource] = Number(url.searchParams.get("ms") ?? "0");
    return answer({ ok: true, latency });
  }
  response.writeHead(404);
  response.end();
};

const server = NodeHttp.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/__fake/")) {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => control(url, request.method ?? "GET", text, response));
    return;
  }
  if (url.pathname === "/graphql") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      recordGraphqlAttempt(request.method ?? "GET", url, body);
      if (request.method !== "POST") {
        count("graphql:unsupported-method", 405, 0);
        send(
          response,
          "graphql",
          405,
          '{"errors":[{"message":"The fake accepts GraphQL POST requests only."}]}',
        );
        return;
      }
      if (remaining("graphql") === 0) {
        count("graphql:limited", 200, 0);
        send(
          response,
          "graphql",
          200,
          '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}',
        );
        return;
      }
      const answer = graphql(body);
      quotas.graphql.used += answer.cost;
      count(answer.kind, 200, answer.cost);
      const withCost =
        body.includes("prkitRateLimit") && typeof answer.data === "object" && answer.data !== null
          ? { ...answer.data, prkitRateLimit: { cost: answer.cost } }
          : answer.data;
      send(
        response,
        "graphql",
        200,
        encodeJson(
          answer.errors === undefined
            ? { data: withCost }
            : { data: withCost, errors: answer.errors },
        ),
      );
    });
    return;
  }
  let text = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    text += chunk;
  });
  request.on("end", () => {
    recordRestAttempt(request.method ?? "GET", url.pathname, text);
    if (remaining("core") === 0) {
      count("rest:limited", 403, 0);
      send(response, "core", 403, '{"message":"API rate limit exceeded for user ID 1."}');
      return;
    }
    const answer = rest(
      url,
      request.method ?? "GET",
      text,
      request.headers["if-none-match"],
      request.headers.authorization ?? "",
    );
    const cost = answer.status === 304 ? 0 : 1;
    quotas.core.used += cost;
    count(answer.kind, answer.status, cost);
    send(
      response,
      "core",
      answer.status,
      answer.body === null ? "" : encodeJson(answer.body),
      "etag" in answer && answer.etag !== undefined ? { etag: answer.etag } : {},
    );
  });
});

const ghConfig = (dir: string, login: string) => {
  NodeFS.mkdirSync(NodePath.join(home, ".config", dir), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, ".config", dir, "hosts.yml"),
    `github.com:\n  user: ${login}\n  users:\n    ${login}: {}\n  git_protocol: https\n`,
  );
};
ghConfig("gh", LOGIN);
if (values["second-account"]) ghConfig("gh-second", SECOND_LOGIN);
NodeFS.writeFileSync(
  NodePath.join(home, "gh"),
  `#!/bin/sh\necho "fake-token-for-$(sed -n 's/^  user: //p' "$GH_CONFIG_DIR/hosts.yml" | head -n 1)"\n`,
  { mode: 0o755 },
);
server.listen(Number(values.port), "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fake has no port.");
  const url = `http://127.0.0.1:${address.port}`;
  NodeFS.writeFileSync(NodePath.join(home, "fake.json"), encodeJson({ url, pid: process.pid }));
  process.stdout.write(`${encodeJson({ type: "ready", url })}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
