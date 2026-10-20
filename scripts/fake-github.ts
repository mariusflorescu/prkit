/**
 * A local fake GitHub for budget checks: it answers the reads prkit makes for one
 * account (`budget-test`) and seven PRs in `budget/fixtures`, sends GitHub's rate limit
 * headers, and counts every request and GraphQL point. No real token or network.
 * PRs 1-6 are the account's own and in its inbox; PR 7 comes from a fork by an
 * outside author and is opened by its URL. PR 8, also opened by its URL, has a history
 * of label, reviewer, title, assignee, base branch, reference and state events by
 * several people, at fixed times, and one mention from a repository the account can't
 * see, which comes back as a null node and a FORBIDDEN error like GitHub's. PR 9, opened
 * by its URL too, changes one file in one hunk of context, a deletion and two additions,
 * and is in the inbox only once a review is requested of the account (`request-review`).
 *
 * PRs 1-3 have a review pending from the account, with one request event at the start;
 * the rest have none. PR 9 joins the inbox's review requests once `request-review` asks for one. A second GraphQL request, `PrkitReviewWaits`, asks for the pending
 * reviewers and the last request and ready events of the inbox's review-requested pull
 * requests, and is counted as `graphql:review-waits`. `shape`, `request-review`, `ready`
 * and the routes next to them seed what it answers.
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
 * in `$GH_CONFIG_DIR/hosts.yml` and that directory's path under `$HOME` (`.config/gh`); pass
 * it to `verify-app start --github-api <url> --gh-home <dir>`.
 * `--second-account` adds `.config/gh-second` for `budget-second`, which sees the same pull
 * requests. `/user` answers for any `budget-` login and refuses any other token like GitHub
 * refuses an expired one (401). The ready line on stdout is
 * `{"type":"ready","url":"http://127.0.0.1:<port>"}`; `<home>/fake.json` records the
 * same url and this pid. Control, all under `/__fake/`:
 *
 *   GET  stats                          counts by kind, GraphQL points, requests while limited, and
 *                                       the latest requests with the login and gh config directory
 *                                       their token is for
 *   POST reset-stats
 *   POST comment?pr=<n>                 a new issue comment (bumps updatedAt)
 *   POST push?pr=<n>                    a new head commit (bumps updatedAt)
 *   POST push?pr=<n>&edit=<i>           a new head commit that also rewrites src/change-<i>.ts
 *                                       (new text, new sha); every other file keeps both
 *   POST push?pr=<n>&shift=<i>          a new head commit that moves only src/change-<i>.ts's hunk
 *                                       to other line numbers (same text, new sha), like a merged base
 *   POST git-head?pr=<n>&sha=<sha>      a local commit is its one head (bumps updatedAt)
 *   POST files?pr=<n>                   its files answer from then on: the JSON list of files in the body
 *   POST texts?pr=<n>                   its head's file texts from then on: JSON `{ [path]: text }` in the body
 *   POST checks?pr=<n>&status=<s>       check run status: queued, in_progress or completed
 *   POST conflict?pr=<n>                the base moved under it: mergeable false, DIRTY
 *   POST checking?pr=<n>                GitHub is still working out mergeability: mergeable null, UNKNOWN
 *   POST require?pr=<n>                 its base requires the `build` check, which starts running
 *   POST merge?pr=<n>                   merged on GitHub; inbox searches still find it for 15 seconds
 *   POST close?pr=<n>                   closed on GitHub without a merge; the account may reopen it
 *   POST draft?pr=<n>                   converted to a draft
 *   POST ready?pr=<n>&minutes=<ago>     no longer a draft, with a ready event that long ago (default 0)
 *   POST shape?pr=<n>&additions=&deletions=&files=&opened=<minutes ago>
 *                                       any subset: its size (the rest keeps its value) and when it was opened
 *   POST request-review?pr=<n>&login=<l>|team=<slug>&minutes=<ago>
 *                                       asks that user or team (a team's slug is `budget/web`), with a
 *                                       request event that long ago (default 0); asking twice adds the event only
 *   POST unrequest?pr=<n>&login=<l>|team=<slug>   takes the request back, as a submitted review does; events stay
 *   POST unreadable?pr=<n>              the waits read answers a null node and a FORBIDDEN error for it from now on
 *   POST odd?pr=<n>                     adds PR n (10 or more) by `outsider` to the involved search, with the
 *                                       unusual shape the JSON body names (see `OddShape` in fake-github/model.ts):
 *                                       an author GitHub types as deleted, a bot, a mannequin or an enterprise
 *                                       account, a deleted fork, labels (or a null label connection), an archived
 *                                       repository, a node that breaks GitHub's own schema, one GitHub refuses,
 *                                       or one whose labels GitHub nulls with an error naming the field
 *   POST fail?kind=<kind>&status=<s>&times=<n>&message=<m>&login=<l>&ms=<d>
 *                                       the next n requests counted as `kind` (say `graphql:review-waits`)
 *                                       get that status (default 502) and `{}`, or `{"message": m}` with a
 *                                       message, counted as `<kind>:failed`; a refused write changes
 *                                       nothing. n defaults to 1, 0 clears it, and reset-stats leaves it alone.
 *                                       With a login, only that login's requests fail; with ms, each
 *                                       failure answers that much later, as GitHub's 502s and 504s do
 *   POST behind?pr=<n>&by=<k>           its base gained k commits, so Update branch applies
 *   POST describe?pr=<n>                its author or description, as JSON `{ "author", "body" }`,
 *                                       either one (bumps updatedAt). PATCH on the pull request
 *                                       changes its title and description too, counted as
 *                                       `rest:pull-edit`
 *   GET  pull?pr=<n>                    its node id, head sha and workflow run ids, for assertions
 *   GET  writes                         every mutation and REST write, with its input
 *   POST limit?resource=graphql|core&seconds=<s>   the limit is used up until then
 *   POST latency?ms=<n>[&resource=graphql|core]   every API answer, or that resource's, waits this long
 *   POST hold?resource=graphql|core[&dir=<d>][&part=body]   that resource's answers wait from now
 *                                       on, until release; with dir, only answers to that gh config
 *                                       directory's token (its path under $HOME, as the stats log names
 *                                       it); with part=body, the status and headers go at once and only
 *                                       the body waits
 *   POST release?resource=graphql|core  sends the answers held since hold, and holds no more
 *   POST archive?repo=<name>            archives a repository, so lists leave it out
 *   POST inbox-only?login=<l>&prs=<n,n> that login's inbox searches find only these pull requests
 *   POST context?pr=<n>                 seeds what the PR says besides its diff (the body is JSON, see
 *                                       fake-github/context.ts): check runs with their output, review
 *                                       threads and the issues it closes. It replaces the PR's earlier
 *                                       seed and bumps updatedAt, like a comment does
 *   POST remaining?resource=core|graphql&count=<n>   only <n> requests (or points) are left in the window
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { decodeSeed, seeds } from "./fake-github/context.ts";
import { graphql } from "./fake-github/graphql.ts";
import {
  addPull,
  archived,
  encodeJson,
  fileChanges,
  head,
  inboxOnly,
  iso,
  LOGIN,
  merge,
  mergeState,
  nodeId,
  OddShape,
  oddShapes,
  pulls,
  resetStats,
  type Reviewer,
  SECOND_LOGIN,
  sameReviewer,
  servedFiles,
  servedTexts,
  sha,
  stats,
  tokenOwner,
  unreadable,
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
const decodeTexts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeOdd = Schema.decodeUnknownSync(Schema.fromJsonString(OddShape));
const decodeDescribe = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      author: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
    }),
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
const held: Record<
  Resource,
  {
    readonly queue: Array<() => void>;
    readonly dir: string | null;
    readonly body: boolean;
  } | null
> = { core: null, graphql: null };

/** By kind, or by kind and login (`<kind>@<login>`) for one account's requests. */
const failures = new Map<
  string,
  { status: number; times: number; message: string | null; ms: number }
>();

const remaining = (resource: Resource) =>
  Date.now() < quotas[resource].limitedUntil ? 0 : Math.max(0, LIMIT - quotas[resource].used);

const tokenLogin = (request: NodeHttp.IncomingMessage) =>
  tokenOwner(request.headers.authorization ?? "").login;

const count = (kind: string, status: number, cost: number, token = "") => {
  const { login, dir } = tokenOwner(token);
  stats.requests++;
  if (kind.startsWith("graphql")) stats.points += cost;
  else stats.rest += cost;
  if (status === 403 || kind.endsWith(":limited")) stats.refused++;
  stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  stats.log.push({ at: iso(Date.now()), kind, status, cost, login, dir });
  if (stats.log.length > 2000) stats.log.shift();
};

const send = (
  response: NodeHttp.ServerResponse,
  resource: Resource,
  status: number,
  body: string,
  headers: Record<string, string> = {},
  token = "",
) => {
  const quota = quotas[resource];
  const reset =
    Date.now() < quota.limitedUntil ? Math.ceil(quota.limitedUntil / 1000) : quota.reset;
  const head = () =>
    response.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": String(LIMIT),
      "x-ratelimit-remaining": String(remaining(resource)),
      "x-ratelimit-used": String(quota.used),
      "x-ratelimit-reset": String(reset),
      "x-ratelimit-resource": resource,
      ...headers,
    });
  const write = () =>
    setTimeout(() => {
      head();
      response.end(body);
    }, latency[resource]);
  const hold = held[resource];
  if (hold === null || (hold.dir !== null && hold.dir !== tokenOwner(token).dir)) write();
  else if (hold.body) {
    head();
    response.flushHeaders();
    hold.queue.push(() => response.end(body));
  } else hold.queue.push(write);
};

const failedByControl = (
  response: NodeHttp.ServerResponse,
  resource: Resource,
  kind: string,
  token = "",
) => {
  const own = `${kind}@${tokenOwner(token).login}`;
  const key = failures.has(own) ? own : kind;
  const failure = failures.get(key);
  if (failure === undefined) return false;
  failure.times--;
  if (failure.times <= 0) failures.delete(key);
  count(`${kind}:failed`, failure.status, 0, token);
  setTimeout(() => {
    send(
      response,
      resource,
      failure.status,
      failure.message === null ? "{}" : encodeJson({ message: failure.message }),
      {},
      token,
    );
  }, failure.ms);
  return true;
};

const reviewerOf = (url: URL): Reviewer | undefined => {
  const login = url.searchParams.get("login");
  const slug = url.searchParams.get("team");
  return login !== null
    ? { kind: "user", login }
    : slug !== null
      ? { kind: "team", slug }
      : undefined;
};
const minutesAgo = (url: URL) =>
  Date.now() - Number(url.searchParams.get("minutes") ?? "0") * 60_000;

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
  if (name === "fail") {
    const kind = url.searchParams.get("kind") ?? "";
    const login = url.searchParams.get("login");
    const key = login === null ? kind : `${kind}@${login}`;
    const times = Number(url.searchParams.get("times") ?? "1");
    if (times > 0)
      failures.set(key, {
        status: Number(url.searchParams.get("status") ?? "502"),
        times,
        message: url.searchParams.get("message"),
        ms: Number(url.searchParams.get("ms") ?? "0"),
      });
    else failures.delete(key);
    return answer({ ok: true, kind, login, times });
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
  if (name === "texts" && method === "POST" && pull !== undefined) {
    servedTexts.set(pull.number, new Map(Object.entries(decodeTexts(text))));
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
  if (name === "context" && method === "POST" && pull !== undefined) {
    try {
      seeds.set(pull.number, decodeSeed(text));
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "The seed could not be read.");
      return;
    }
    pull.updatedAt = Date.now();
    return answer({ ok: true });
  }
  if (name === "remaining" && method === "POST") {
    const resource = url.searchParams.get("resource") === "graphql" ? "graphql" : "core";
    const count = Math.max(0, Number(url.searchParams.get("count") ?? "0"));
    quotas[resource].used = Math.max(0, LIMIT - count);
    return answer({ ok: true, resource, remaining: remaining(resource) });
  }
  if (name === "push" && pull !== undefined) {
    const edit = url.searchParams.get("edit");
    const shift = url.searchParams.get("shift");
    const which = edit ?? shift;
    if (which !== null) {
      const index = Number(which);
      if (
        (edit !== null && shift !== null) ||
        pull.number === 9 ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= pull.heads.length
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          encodeJson({ message: "Use edit or shift once, with the index of a file the PR has." }),
        );
        return;
      }
      const key = `${pull.number}:${index}`;
      const changed = fileChanges.get(key) ?? { edits: 0, shifts: 0 };
      fileChanges.set(
        key,
        edit === null
          ? { ...changed, shifts: changed.shifts + 1 }
          : { ...changed, edits: changed.edits + 1 },
      );
    }
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
  if (name === "ready" && pull !== undefined) {
    pull.draft = false;
    pull.reviewEvents.push({ kind: "ready", at: minutesAgo(url) });
    return answer({ ok: true });
  }
  if (name === "shape" && pull !== undefined) {
    const given = (key: string) => {
      const value = url.searchParams.get(key);
      return value === null ? undefined : Number(value);
    };
    pull.size = {
      additions: given("additions") ?? pull.size.additions,
      deletions: given("deletions") ?? pull.size.deletions,
      files: given("files") ?? pull.size.files,
    };
    const opened = given("opened");
    if (opened !== undefined) pull.createdAt = Date.now() - opened * 60_000;
    return answer({ ok: true, size: pull.size });
  }
  if (name === "request-review" && pull !== undefined) {
    const reviewer = reviewerOf(url);
    if (reviewer !== undefined) {
      if (!pull.requested.some((pending) => sameReviewer(pending, reviewer)))
        pull.requested.push(reviewer);
      pull.reviewEvents.push({ kind: "requested", at: minutesAgo(url), reviewer });
      return answer({ ok: true });
    }
  }
  if (name === "unrequest" && pull !== undefined) {
    const reviewer = reviewerOf(url);
    if (reviewer !== undefined) {
      pull.requested = pull.requested.filter((pending) => !sameReviewer(pending, reviewer));
      return answer({ ok: true });
    }
  }
  if (name === "odd" && method === "POST") {
    const number = Number(url.searchParams.get("pr"));
    if (Number.isInteger(number) && number >= 10 && !pulls.has(number)) {
      const shape = decodeOdd(text);
      oddShapes.set(number, shape);
      addPull(number, shape);
      return answer({ ok: true });
    }
  }
  if (name === "unreadable" && pull !== undefined) {
    unreadable.add(pull.number);
    return answer({ ok: true });
  }
  if (name === "describe" && method === "POST" && pull !== undefined) {
    const given = decodeDescribe(text);
    if (given.author !== undefined) pull.author = given.author;
    if (given.body !== undefined) pull.body = given.body;
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
  if (name === "inbox-only") {
    const prs = (url.searchParams.get("prs") ?? "").split(",").filter((item) => item !== "");
    inboxOnly.set(url.searchParams.get("login") ?? "", new Set(prs.map(Number)));
    return answer({ ok: true });
  }
  if (name === "archive") {
    archived.add(url.searchParams.get("repo") ?? "");
    return answer({ ok: true, archived: [...archived] });
  }
  if (name === "hold" || name === "release") {
    const resource = url.searchParams.get("resource") === "core" ? "core" : "graphql";
    const queue = held[resource]?.queue ?? [];
    held[resource] =
      name === "hold"
        ? {
            queue,
            dir: url.searchParams.get("dir"),
            body: url.searchParams.get("part") === "body",
          }
        : null;
    if (name === "release") for (const write of queue) write();
    return answer({ ok: true, resource, held: queue.length });
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
      const answer = graphql(body, tokenLogin(request));
      if (failedByControl(response, "graphql", answer.kind, request.headers.authorization)) return;
      quotas.graphql.used += answer.cost;
      count(answer.kind, 200, answer.cost, request.headers.authorization);
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
        {},
        request.headers.authorization,
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
    if (failedByControl(response, "core", answer.kind, request.headers.authorization)) return;
    if ("commit" in answer) answer.commit();
    const cost = answer.status === 304 ? 0 : 1;
    quotas.core.used += cost;
    count(answer.kind, answer.status, cost, request.headers.authorization);
    send(
      response,
      "core",
      answer.status,
      answer.body === null ? "" : encodeJson(answer.body),
      "etag" in answer && answer.etag !== undefined ? { etag: answer.etag } : {},
      request.headers.authorization,
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
  `#!/bin/sh\necho "fake-token-for-$(sed -n 's/^  user: //p' "$GH_CONFIG_DIR/hosts.yml" | head -n 1)@\${GH_CONFIG_DIR#"$HOME"/}"\n`,
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
