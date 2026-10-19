import * as Schema from "effect/Schema";

import { nodesOf } from "../github/connection.ts";
import type { GraphQLError } from "../github/GitHubApi.ts";

/** An issue a pull request says it closes, by a keyword in its description or a link made on GitHub. */
export const ClosingIssue = Schema.Struct({
  /** `owner/name`: an issue can live in another repository. */
  repository: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  body: Schema.String,
});
export type ClosingIssue = typeof ClosingIssue.Type;

/** The first issues GitHub lists, and how many it lists in all. */
export const ClosingIssues = Schema.Struct({
  total: Schema.Int,
  items: Schema.Array(ClosingIssue),
});
export type ClosingIssues = typeof ClosingIssues.Type;

export const CLOSING_ISSUES_LIMIT = 10;

export const CLOSING_ISSUES_QUERY = `query PrkitClosingIssues($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: ${CLOSING_ISSUES_LIMIT}) {
        totalCount
        nodes { number title body url state repository { nameWithOwner } }
      }
    }
  }
}`;

export const ClosingIssuesResponse = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          closingIssuesReferences: Schema.NullOr(
            Schema.Struct({
              totalCount: Schema.Int,
              nodes: nodesOf(
                Schema.Struct({
                  number: Schema.Int,
                  title: Schema.String,
                  body: Schema.String,
                  url: Schema.String,
                  state: Schema.Literals(["OPEN", "CLOSED"]),
                  repository: Schema.Struct({ nameWithOwner: Schema.String }),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

const NODES = ["repository", "pullRequest", "closingIssuesReferences", "nodes"];
/**
 * GitHub answers an issue it won't show, such as one in a repository behind SAML SSO, as
 * a null node with an error under `closingIssuesReferences.nodes`. The rest still reads.
 */
export const withheld = (error: GraphQLError) =>
  NODES.every((key, index) => error.path?.[index] === key);

/** Null when the repository or the pull request isn't there. */
export const closingIssuesOf = (
  response: typeof ClosingIssuesResponse.Type,
): ClosingIssues | null => {
  const pullRequest = response.repository?.pullRequest;
  if (pullRequest == null) return null;
  const references = pullRequest.closingIssuesReferences;
  if (references === null) return { total: 0, items: [] };
  return {
    total: references.totalCount,
    items: references.nodes.map((node) => ({
      repository: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      state: node.state === "OPEN" ? ("open" as const) : ("closed" as const),
      body: node.body,
    })),
  };
};
