import type { AccountId, FileSide, PullRequestRef, ReviewThread } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { nodesOf } from "../github/connection.ts";
import { GitHubApi, unreachable } from "../github/GitHubApi.ts";

const PAGES = 10;
const THREADS_QUERY = `query PrkitReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line startLine originalLine diffSide startDiffSide
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: 100) {
            totalCount
            nodes {
              id body createdAt url diffHunk
              author { __typename login avatarUrl }
              reactionGroups { content reactors { totalCount } }
            }
          }
        }
      }
    }
  }
}`;
const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
}`;
const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;
const UNRESOLVE_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const Side = Schema.Literals(["LEFT", "RIGHT"]);
const Thread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  startLine: Schema.NullOr(Schema.Int),
  originalLine: Schema.NullOr(Schema.Int),
  diffSide: Side,
  startDiffSide: Schema.NullOr(Side),
  viewerCanReply: Schema.Boolean,
  viewerCanResolve: Schema.Boolean,
  viewerCanUnresolve: Schema.Boolean,
  comments: Schema.Struct({
    totalCount: Schema.Int,
    nodes: nodesOf(
      Schema.Struct({
        id: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        url: Schema.String,
        diffHunk: Schema.String,
        author: Schema.NullOr(
          Schema.Struct({
            __typename: Schema.String,
            login: Schema.String,
            avatarUrl: Schema.String,
          }),
        ),
        reactionGroups: Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              content: Schema.String,
              reactors: Schema.Struct({ totalCount: Schema.Int }),
            }),
          ),
        ),
      }),
    ),
  }),
});
const Page = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          headRefOid: Schema.String,
          reviewThreads: Schema.Struct({
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: nodesOf(Thread),
          }),
        }),
      ),
    }),
  ),
});
const Ok = Schema.Struct({});

const EMOJI: Readonly<Record<string, string>> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};
const side = (value: typeof Side.Type): FileSide => (value === "LEFT" ? "old" : "new");

const toThread = (thread: typeof Thread.Type): ReviewThread => ({
  id: thread.id,
  path: thread.path,
  anchor:
    thread.line === null
      ? null
      : {
          path: thread.path,
          start: {
            side: side(thread.startDiffSide ?? thread.diffSide),
            line: thread.startLine ?? thread.line,
          },
          end: { side: side(thread.diffSide), line: thread.line },
        },
  originalLine: thread.originalLine,
  diffHunk: thread.comments.nodes[0]?.diffHunk ?? "",
  resolved: thread.isResolved,
  canReply: thread.viewerCanReply,
  canResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
  comments: thread.comments.nodes.map((comment) => ({
    id: comment.id,
    // GraphQL names a bot without the `[bot]` that REST and the rest of prkit show.
    author:
      comment.author === null
        ? null
        : {
            login:
              comment.author.__typename === "Bot"
                ? `${comment.author.login}[bot]`
                : comment.author.login,
            avatarUrl: comment.author.avatarUrl,
          },
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    reactions: (comment.reactionGroups ?? []).flatMap((group) => {
      const emoji = EMOJI[group.content];
      return emoji === undefined || group.reactors.totalCount === 0
        ? []
        : [{ emoji, count: group.reactors.totalCount }];
    }),
  })),
  commentCount: thread.comments.totalCount,
});

/** Review threads on a PR's diff lines, and the two things a reviewer does to one. */
export const makeReviewThreads = Effect.gen(function* () {
  const api = yield* GitHubApi;
  const read = (accountId: AccountId, ref: PullRequestRef) =>
    Effect.gen(function* () {
      const threads: Array<ReviewThread> = [];
      let headSha = "";
      let cursor: string | null = null;
      for (let page = 0; page < PAGES; page++) {
        const variables: Record<string, string | number> = {
          owner: ref.owner,
          name: ref.repo,
          number: ref.number,
        };
        if (cursor !== null) variables["cursor"] = cursor;
        const response: typeof Page.Type = yield* api.graphql(
          accountId,
          THREADS_QUERY,
          Page,
          variables,
        );
        const pullRequest = response.repository?.pullRequest;
        if (pullRequest == null)
          return yield* unreachable(accountId, `${ref.owner}/${ref.repo}#${ref.number}`);
        if (page === 0) headSha = pullRequest.headRefOid;
        const connection = pullRequest.reviewThreads;
        for (const node of connection.nodes) threads.push(toThread(node));
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        if (cursor === null) break;
      }
      return { headSha, threads, truncated: cursor !== null };
    });
  const reply = (accountId: AccountId, threadId: string, body: string) =>
    api.graphql(accountId, REPLY_MUTATION, Ok, { threadId, body }).pipe(Effect.asVoid);
  const setResolved = (accountId: AccountId, threadId: string, resolved: boolean) =>
    api
      .graphql(accountId, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, Ok, { threadId })
      .pipe(Effect.asVoid);
  return { read, reply, setResolved };
});
