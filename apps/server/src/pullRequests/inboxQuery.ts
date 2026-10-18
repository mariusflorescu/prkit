import * as Schema from "effect/Schema";

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
  labels: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(Schema.Struct({ name: Schema.String, color: Schema.String })),
    ),
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
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
    ),
  }),
});
const Search = Schema.Struct({
  issueCount: Schema.Int,
  nodes: Schema.Array(Schema.NullOr(PullRequestNode)),
});
export const InboxResponse = Schema.Struct({
  reviewRequested: Search,
  authored: Search,
  involved: Search,
});
export type InboxResponse = typeof InboxResponse.Type;
export type PullRequestNode = typeof PullRequestNode.Type;
