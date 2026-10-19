import type {
  AccountId,
  PullRequestKey,
  PullRequestRef,
  PullRequestStatus,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

import { StackFields, stackSelection } from "./stackQuery.ts";

/**
 * What the watcher reads to notice that a PR changed: scalar fields, two totals
 * and the PR's place in its stack, no lists, so a batch of 50 PRs costs about one point.
 */
export const PullRequestFingerprint = Schema.Struct({
  ...StackFields,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  updatedAt: Schema.String,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  baseRefName: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  mergeStateStatus: Schema.String,
  comments: Schema.Struct({ totalCount: Schema.Int }),
  reviews: Schema.NullOr(Schema.Struct({ totalCount: Schema.Int })),
});
export type PullRequestFingerprint = typeof PullRequestFingerprint.Type;

const FIELDS =
  "title state isDraft updatedAt headRefOid baseRefOid baseRefName reviewDecision mergeStateStatus comments { totalCount } reviews { totalCount }";

/**
 * The fields a stack strip shows of this PR. When they change, the cached stack is
 * read again; a new comment or review doesn't touch it.
 */
export const stackShape = (fingerprint: PullRequestFingerprint) =>
  JSON.stringify([
    fingerprint.title,
    fingerprint.state,
    fingerprint.isDraft,
    fingerprint.headRefOid,
    fingerprint.baseRefName,
    fingerprint.stack ?? null,
    fingerprint.stackEntry ?? null,
  ]);

/**
 * One aliased field per PR (`p0`, `p1`, ...); owner, name and number travel as
 * variables. The query is built with or without stack fields, as the host allows.
 */
export const fingerprintQuery = (refs: ReadonlyArray<PullRequestRef>) => {
  const variables: Record<string, string | number> = {};
  const declarations: Array<string> = [];
  const fields: Array<(stacks: boolean) => string> = [];
  refs.forEach((ref, index) => {
    declarations.push(`$o${index}: String!, $r${index}: String!, $n${index}: Int!`);
    fields.push(
      (stacks) =>
        `  p${index}: repository(owner: $o${index}, name: $r${index}) { pullRequest(number: $n${index}) { ${FIELDS} ${stackSelection(stacks)} } }`,
    );
    variables[`o${index}`] = ref.owner;
    variables[`r${index}`] = ref.repo;
    variables[`n${index}`] = ref.number;
  });
  return {
    query: (stacks: boolean) =>
      `query PrkitWatch(${declarations.join(", ")}) {\n${fields.map((field) => field(stacks)).join("\n")}\n}`,
    variables,
  };
};

export const FingerprintResponse = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(PullRequestFingerprint) })),
);

export const pullRequestState = (fingerprint: PullRequestFingerprint) =>
  fingerprint.state === "OPEN" ? "open" : fingerprint.state === "MERGED" ? "merged" : "closed";

export const statusOf = (
  key: PullRequestKey,
  accountId: AccountId,
  fingerprint: PullRequestFingerprint,
): PullRequestStatus => ({
  key,
  accountId,
  title: fingerprint.title,
  state: pullRequestState(fingerprint),
  isDraft: fingerprint.isDraft,
});
