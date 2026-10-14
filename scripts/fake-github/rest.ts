// The fake GitHub's REST answers: pulls, files, reviews, comments, checks and workflow runs.
import * as Schema from "effect/Schema";

import {
  BASE,
  encodeJson,
  head,
  headRef,
  iso,
  LOGIN,
  OWNER,
  type Pull,
  position,
  pulls,
  REPO,
  sha,
  STACK,
  start,
  wrote,
} from "./model.ts";
import { STACKS } from "./options.ts";

let nextReview = 50_000;
const user = { login: LOGIN, avatar_url: "" };
/** PR 9's one file: a hunk with context, a deletion and two additions. */
const LIMITS_FILE = {
  filename: "src/limits.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: [
    "@@ -1,6 +1,7 @@",
    " export const limits = {",
    "-  url: 1024,",
    "+  url: 2048,",
    "+  slug: 64,",
    "   title: 120,",
    " };",
    " ",
    ' export const schemes = ["http", "https"];',
  ].join("\n"),
};
const REPOSITORY = { id: 4242, name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } };
const restPull = (pull: Pull) => ({
  title: pull.title,
  body: `Body of fixture ${pull.number}`,
  state: pull.state === "OPEN" ? "open" : "closed",
  draft: pull.draft,
  merged: pull.state === "MERGED",
  merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
  mergeable: pull.checking ? null : !pull.conflicting,
  user: { login: pull.author, avatar_url: "" },
  author_association: pull.association,
  head: { ref: headRef(pull), sha: head(pull), repo: { full_name: pull.headRepo } },
  base: { ref: "main", sha: BASE, repo: REPOSITORY },
  requested_reviewers: [],
  requested_teams: [],
  labels:
    pull.number === 8
      ? [
          { name: "bug", color: "d73a4a" },
          { name: "docs", color: "0075ca" },
          { name: "stale", color: "000000" },
        ]
      : [],
  additions: pull.heads.length,
  deletions: 0,
  changed_files: pull.heads.length,
  html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}`,
  created_at: iso(start),
  updated_at: iso(pull.updatedAt),
  ...(STACKS
    ? {
        stack:
          position(pull) === 0
            ? null
            : { number: 900, size: STACK.length, position: position(pull), base: { ref: "main" } },
      }
    : {}),
});

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const REVIEW_STATES: Record<string, string> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};
const runOf = (pull: Pull, run: Pull["runs"][number]) => ({
  id: run.id,
  status: run.status,
  conclusion: run.conclusion,
  head_sha: head(pull),
  head_branch: headRef(pull),
  head_repository: { full_name: pull.headRepo },
  // GitHub lists no pull requests on a run from a fork.
  pull_requests: [],
});

export const rest = (
  url: URL,
  method: string,
  text: string,
  ifNoneMatch: string | undefined,
  token: string,
) => {
  const path = url.pathname;
  if (path === "/user") {
    const login = token.replace(/^(Bearer|token) fake-token-for-/, "");
    return login.startsWith("budget-")
      ? { kind: "rest:user", status: 200, body: { login, avatar_url: "", name: "Budget Test" } }
      : { kind: "rest:user-refused", status: 401, body: { message: "Bad credentials" } };
  }
  if (path === `/repos/${OWNER}/${REPO}`)
    return { kind: "rest:repository", status: 200, body: REPOSITORY };
  const match =
    /^\/repos\/budget\/fixtures\/(pulls|issues|commits|compare|contents|actions)\/([^/]+)(?:\/(.*))?$/.exec(
      path,
    );
  if (match === null) return { kind: "rest:unknown", status: 404, body: { message: "Not Found" } };
  const [, area, id, tail] = match;
  const page = Number(url.searchParams.get("page") ?? "1");
  const pull = pulls.get(Number(id));
  if (area === "pulls" && pull !== undefined) {
    if (tail === undefined) return { kind: "rest:pull", status: 200, body: restPull(pull) };
    if (tail === "files")
      return {
        kind: "rest:files",
        status: 200,
        body:
          page > 1
            ? []
            : pull.number === 9
              ? [LIMITS_FILE]
              : pull.heads.map((commit, index) => ({
                  filename: `src/change-${index}.ts`,
                  status: "added",
                  additions: 1,
                  deletions: 0,
                  patch: `@@ -0,0 +1 @@\n+export const change${index} = "${commit.message}";`,
                })),
      };
    if (tail === "reviews" && method === "POST") {
      const input = decodeBody(text || "{}");
      wrote(`POST pulls/${pull.number}/reviews`, input);
      if (pull.author === LOGIN && input["event"] !== "COMMENT")
        return {
          kind: "rest:review-refused",
          status: 422,
          body: { message: "Unprocessable Entity: Can not approve your own pull request" },
        };
      const review = {
        id: nextReview++,
        login: LOGIN,
        state: REVIEW_STATES[String(input["event"])] ?? "COMMENTED",
        body: String(input["body"] ?? ""),
        at: Date.now(),
      };
      pull.reviews.push(review);
      pull.updatedAt = Date.now();
      return {
        kind: "rest:review",
        status: 200,
        body: {
          id: review.id,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}#pullrequestreview-${review.id}`,
        },
      };
    }
    if (tail === "reviews")
      return {
        kind: "rest:reviews",
        status: 200,
        body:
          page > 1
            ? []
            : pull.reviews.map((review) => ({
                id: review.id,
                user: { login: review.login, avatar_url: "" },
                body: review.body,
                state: review.state,
                submitted_at: iso(review.at),
                html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}#pullrequestreview-${review.id}`,
              })),
      };
    return { kind: `rest:${tail}`, status: 200, body: [] };
  }
  if (area === "actions" && id === "runs") {
    const [runId, action] = (tail ?? "").split("/");
    if (runId === "") {
      const sha = url.searchParams.get("head_sha");
      return {
        kind: "rest:runs",
        status: 200,
        body: {
          workflow_runs:
            page > 1
              ? []
              : [...pulls.values()].flatMap((candidate) =>
                  head(candidate) === sha ? candidate.runs.map((run) => runOf(candidate, run)) : [],
                ),
        },
      };
    }
    const owner = [...pulls.values()].find((candidate) =>
      candidate.runs.some((run) => String(run.id) === runId),
    );
    const run = owner?.runs.find((candidate) => String(candidate.id) === runId);
    if (owner === undefined || run === undefined)
      return { kind: "rest:unknown", status: 404, body: { message: "Not Found" } };
    if (action === "approve" && method === "POST") {
      wrote(`POST actions/runs/${run.id}/approve`, {});
      if (run.conclusion !== "action_required")
        return {
          kind: "rest:run-approve-refused",
          status: 403,
          body: { message: "This run is not from a fork pull request" },
        };
      run.status = "queued";
      run.conclusion = null;
      return { kind: "rest:run-approve", status: 201, body: {} };
    }
    return { kind: "rest:run", status: 200, body: runOf(owner, run) };
  }
  if (area === "issues" && pull !== undefined && tail === "comments")
    return {
      kind: "rest:comments",
      status: 200,
      body:
        page > 1
          ? []
          : pull.comments.map((comment) => ({
              id: comment.id,
              user,
              body: comment.body,
              created_at: iso(comment.at),
              html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}#issuecomment-${comment.id}`,
            })),
    };
  if (area === "commits") {
    const owner = [...pulls.values()].find((candidate) => head(candidate) === id);
    const status = owner?.checks ?? "completed";
    const body =
      tail?.startsWith("check-runs") === true
        ? {
            check_runs:
              page > 1
                ? []
                : [
                    {
                      id: 1,
                      name: "build",
                      status,
                      conclusion: status === "completed" ? "success" : null,
                      html_url: null,
                    },
                  ],
          }
        : [];
    const etag = `"${sha(encodeJson(body))}"`;
    if (ifNoneMatch === etag) return { kind: `rest:${tail}:304`, status: 304, body: null, etag };
    return { kind: `rest:${tail}`, status: 200, body, etag };
  }
  if (area === "compare")
    return { kind: "rest:compare", status: 200, body: { merge_base_commit: { sha: BASE } } };
  if (area === "contents")
    return {
      kind: "rest:contents",
      status: 200,
      body: {
        content: Buffer.from("export {};\n").toString("base64"),
        encoding: "base64",
        size: 11,
      },
    };
  return { kind: "rest:unknown", status: 404, body: { message: "Not Found" } };
};
