import { type Account, type InboxLeftOut, PullRequestRef } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { nodesOf } from "../github/connection.ts";
import { decodeProblem, type GraphQLError } from "../github/GitHubApi.ts";
import { StackFields, stackSelection } from "./stackQuery.ts";

/** What a list row shows of a pull request, as a fragment on `PullRequest`. */
export const pullRequestRowFragment = (stacks: boolean) => `fragment PullRequestRow on PullRequest {
  id number title url state isDraft createdAt updatedAt
  headRefName baseRefName additions deletions changedFiles reviewDecision
  author { login avatarUrl }
  repository { name owner { login } }
  labels(first: 100) { nodes { name color } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  ${stackSelection(stacks)}
}`;

/** GitHub's most for one connection's `first` and for one `nodes(ids:)`, so one search's pull requests fit one waits read. */
export const GITHUB_PAGE_LIMIT = 100;

/** The account's three searches, with each PR's place in its stack where the host has stacks. */
export const inboxQuery = (stacks: boolean) => `query PrkitInbox {
  reviewRequested: search(query: "is:pr is:open archived:false review-requested:@me sort:updated-desc", type: ISSUE, first: ${GITHUB_PAGE_LIMIT}) { ...InboxSearch }
  authored: search(query: "is:pr is:open archived:false author:@me sort:updated-desc", type: ISSUE, first: ${GITHUB_PAGE_LIMIT}) { ...InboxSearch }
  involved: search(query: "is:pr is:open archived:false involves:@me sort:updated-desc", type: ISSUE, first: ${GITHUB_PAGE_LIMIT}) { ...InboxSearch }
}
fragment InboxSearch on SearchResultItemConnection {
  issueCount
  nodes { ...PullRequestRow }
}
${pullRequestRowFragment(stacks)}`;

export const PullRequestNode = Schema.Struct({
  ...StackFields,
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
  ),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
  repository: Schema.Struct({
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
  }),
  labels: Schema.NullOr(
    Schema.Struct({ nodes: nodesOf(Schema.Struct({ name: Schema.String, color: Schema.String })) }),
  ),
  commits: Schema.Struct({
    nodes: nodesOf(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({
              state: Schema.Literals(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
            }),
          ),
        }),
      }),
    ),
  }),
});
const Search = Schema.Struct({
  issueCount: Schema.Int,
  /** Read one by one with `readNodes`, so a pull request prkit can't read fails alone. */
  nodes: Schema.NullOr(Schema.Array(Schema.Json)),
});
export const InboxResponse = Schema.Struct({
  reviewRequested: Search,
  authored: Search,
  involved: Search,
});
export type InboxResponse = typeof InboxResponse.Type;
export type PullRequestNode = typeof PullRequestNode.Type;

const decodeNode = Schema.decodeUnknownResult(PullRequestNode);
/** What still names a pull request whose row doesn't read. */
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    number: PullRequestRef.fields.number,
    url: Schema.String,
    repository: PullRequestNode.fields.repository,
  }),
);
const isAt = (error: GraphQLError, at: ReadonlyArray<string | number>) =>
  at.every((segment, index) => error.path?.[index] === segment);

/** Whether a GraphQL error belongs to one node of the list at `at`, such as `["authored", "nodes"]`. */
export const isNodeError = (error: GraphQLError, at: ReadonlyArray<string>) =>
  isAt(error, at) && typeof error.path?.[at.length] === "number";

/**
 * A list's pull request nodes, each read on its own. One prkit can't read is left out, named
 * when its number and address still read, with where it broke for the log, never what it held.
 * A null node is one GitHub refused when an error names it, and nothing otherwise.
 */
export const readNodes = (
  account: Pick<Account, "id" | "host">,
  at: ReadonlyArray<string>,
  nodes: ReadonlyArray<Schema.Json>,
  errors: ReadonlyArray<GraphQLError>,
) => {
  const rows: Array<PullRequestNode> = [];
  const leftOut: Array<InboxLeftOut> = [];
  const problems: Array<{ readonly path: string; readonly problem: string }> = [];
  nodes.forEach((raw, index) => {
    const refused = errors.find((error) => isAt(error, [...at, index]));
    const decoded = raw === null ? null : decodeNode(raw);
    if (decoded !== null && Result.isSuccess(decoded)) {
      rows.push(decoded.success);
      return;
    }
    if (decoded === null && refused === undefined) return;
    const named = Option.getOrNull(decodeIdentity(raw));
    leftOut.push({
      accountId: account.id,
      pullRequest:
        named === null
          ? null
          : {
              ref: {
                host: account.host,
                owner: named.repository.owner.login,
                repo: named.repository.name,
                number: named.number,
              },
              url: named.url,
            },
      message: refused?.message ?? null,
    });
    if (decoded !== null) {
      const problem = decodeProblem(decoded.failure);
      problems.push({
        path: [...at, index, ...(problem.path === "" ? [] : [problem.path])].join("."),
        problem: problem.problem,
      });
    }
  });
  return { rows, leftOut, problems };
};
