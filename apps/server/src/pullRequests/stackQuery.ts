import type { PullRequestStack, StackMembership } from "@prkit/contracts";
import * as Schema from "effect/Schema";

import { nodesOf } from "../github/connection.ts";

/** A PR's place in its stack, for a pull request selection on a host with stacks. */
export const stackSelection = (stacks: boolean) =>
  stacks ? "stack { number size baseRefName } stackEntry { position }" : "";

/** Optional so the same schema reads hosts without stacks. */
export const StackFields = {
  stack: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ number: Schema.Int, size: Schema.Int, baseRefName: Schema.String }),
    ),
  ),
  stackEntry: Schema.optionalKey(Schema.NullOr(Schema.Struct({ position: Schema.Int }))),
};
const StackNode = Schema.Struct(StackFields);

export const membershipOf = (node: typeof StackNode.Type): StackMembership | null =>
  node.stack == null || node.stackEntry == null
    ? null
    : {
        number: node.stack.number,
        size: node.stack.size,
        position: node.stackEntry.position,
        base: node.stack.baseRefName,
      };

/** The `stack` of a REST pull request: present only on hosts with stacks, for a PR in one. */
export const RestStack = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      number: Schema.optionalKey(Schema.Int),
      size: Schema.optionalKey(Schema.Int),
      position: Schema.optionalKey(Schema.Int),
      base: Schema.Struct({ ref: Schema.String }),
    }),
  ),
);

export const restMembership = (
  stack: Schema.Schema.Type<typeof RestStack> | undefined,
): StackMembership | null =>
  stack == null ||
  stack.number === undefined ||
  stack.size === undefined ||
  stack.position === undefined
    ? null
    : { number: stack.number, size: stack.size, position: stack.position, base: stack.base.ref };

export const STACK_QUERY = `query PrkitStack($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      stack {
        number
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest { number title state isDraft headRefName baseRefName additions deletions }
          }
        }
      }
    }
  }
}`;

export const StackResponse = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          stack: Schema.NullOr(
            Schema.Struct({
              number: Schema.Int,
              baseRefName: Schema.String,
              entries: Schema.Struct({
                nodes: nodesOf(
                  Schema.Struct({
                    position: Schema.Int,
                    pullRequest: Schema.NullOr(
                      Schema.Struct({
                        number: Schema.Int,
                        title: Schema.String,
                        state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
                        isDraft: Schema.Boolean,
                        headRefName: Schema.String,
                        baseRefName: Schema.String,
                        additions: Schema.Int,
                        deletions: Schema.Int,
                      }),
                    ),
                  }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const stackOf = (response: typeof StackResponse.Type): PullRequestStack | null => {
  const stack = response.repository?.pullRequest?.stack;
  if (stack == null) return null;
  return {
    number: stack.number,
    base: stack.baseRefName,
    layers: stack.entries.nodes
      .flatMap((entry) =>
        entry.pullRequest === null
          ? []
          : [
              {
                position: entry.position,
                number: entry.pullRequest.number,
                title: entry.pullRequest.title,
                state:
                  entry.pullRequest.state === "OPEN"
                    ? ("open" as const)
                    : entry.pullRequest.state === "MERGED"
                      ? ("merged" as const)
                      : ("closed" as const),
                isDraft: entry.pullRequest.isDraft,
                headBranch: entry.pullRequest.headRefName,
                baseBranch: entry.pullRequest.baseRefName,
                additions: entry.pullRequest.additions,
                deletions: entry.pullRequest.deletions,
              },
            ],
      )
      .toSorted((left, right) => left.position - right.position),
  };
};
