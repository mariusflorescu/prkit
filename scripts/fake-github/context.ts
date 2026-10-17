// What a journey seeds into a pull request besides its diff: check results, review threads and linked issues.
import * as Schema from "effect/Schema";

import { iso, OWNER, type Pull, REPO, start } from "./model.ts";

export const ContextSeed = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      status: Schema.Literals(["queued", "in_progress", "completed"]),
      conclusion: Schema.NullOr(Schema.String),
      title: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
    }),
  ),
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      /** Null once the code the thread was written on moved on, like GitHub's outdated threads. */
      line: Schema.NullOr(Schema.Int),
      originalLine: Schema.Int,
      resolved: Schema.Boolean,
      comments: Schema.Array(
        Schema.Struct({ id: Schema.Int, login: Schema.String, body: Schema.String }),
      ),
    }),
  ),
  issues: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      number: Schema.Int,
      title: Schema.String,
      body: Schema.String,
      state: Schema.Literals(["OPEN", "CLOSED"]),
    }),
  ),
});
export type ContextSeed = typeof ContextSeed.Type;
export const decodeSeed = Schema.decodeUnknownSync(Schema.fromJsonString(ContextSeed));

/** The seeds by PR number. A PR without one answers exactly as it did before seeding existed. */
export const seeds = new Map<number, ContextSeed>();

const CLOSING_ISSUES_LIMIT = 10;
const HUNK = [
  "@@ -1,5 +1,6 @@",
  " export const limits = {",
  "-  url: 1024,",
  "+  url: 2048,",
  "+  slug: 64,",
  "   title: 120,",
].join("\n");

export const seededCheckRuns = (seed: ContextSeed) =>
  seed.checks.map((check) => ({
    id: check.id,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    html_url: `https://github.com/${OWNER}/${REPO}/runs/${check.id}`,
    output: { title: check.title ?? null, summary: check.summary ?? null },
  }));

/** The review threads in GitHub's GraphQL node shape. */
export const seededThreads = (pull: Pull, seed: ContextSeed) =>
  seed.threads.map((thread, index) => ({
    id: thread.id,
    isResolved: thread.resolved,
    path: thread.path,
    line: thread.line,
    startLine: null,
    originalLine: thread.originalLine,
    diffSide: "RIGHT",
    startDiffSide: null,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: {
      totalCount: thread.comments.length,
      nodes: thread.comments.map((comment, position) => ({
        id: `comment-${comment.id}`,
        body: comment.body,
        createdAt: iso(start + (index * 10 + position) * 60_000),
        url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}#discussion_r${comment.id}`,
        diffHunk: HUNK,
        author: { __typename: "User", login: comment.login, avatarUrl: "" },
        reactionGroups: [],
      })),
    },
  }));

export const seededIssues = (seed: ContextSeed) => ({
  totalCount: seed.issues.length,
  nodes: seed.issues.slice(0, CLOSING_ISSUES_LIMIT).map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: `https://github.com/${issue.repository}/issues/${issue.number}`,
    state: issue.state,
    repository: { nameWithOwner: issue.repository },
  })),
});
