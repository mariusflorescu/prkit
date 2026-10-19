import {
  PullRequestActionPreferences,
  PullRequestMergeMethod,
  type AccountId,
  type PullRequestRef,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { nodesOf } from "../github/connection.ts";
import { GitHubApi, GitHubRequestError } from "../github/GitHubApi.ts";

const Method = Schema.Literals(["MERGE", "SQUASH", "REBASE"]);
const Pull = Schema.Struct({
  id: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
  ),
  mergeStateStatus: Schema.String,
  isMergeQueueEnabled: Schema.Boolean,
  isCrossRepository: Schema.Boolean,
  viewerCanUpdate: Schema.Boolean,
  viewerCanUpdateBranch: Schema.Boolean,
  viewerCanClose: Schema.Boolean,
  viewerCanReopen: Schema.Boolean,
  viewerCanLabel: Schema.Boolean,
  viewerCanAssign: Schema.Boolean,
  viewerCanEnableAutoMerge: Schema.Boolean,
  viewerCanDisableAutoMerge: Schema.Boolean,
  autoMergeRequest: Schema.NullOr(Schema.Struct({ mergeMethod: Method })),
  baseRef: Schema.NullOr(
    Schema.Struct({ compare: Schema.NullOr(Schema.Struct({ behindBy: Schema.Int })) }),
  ),
  mergeTitle: Schema.String,
  mergeBody: Schema.String,
  squashTitle: Schema.String,
  squashBody: Schema.String,
  commits: Schema.Struct({
    nodes: nodesOf(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      }),
    ),
  }),
});
const Response = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      mergeCommitAllowed: Schema.Boolean,
      squashMergeAllowed: Schema.Boolean,
      rebaseMergeAllowed: Schema.Boolean,
      autoMergeAllowed: Schema.Boolean,
      isArchived: Schema.Boolean,
      viewerPermission: Schema.NullOr(Schema.String),
      viewerDefaultMergeMethod: Method,
      pullRequest: Schema.NullOr(Pull),
    }),
  ),
});
const QUERY = `query PrkitPullRequestActions($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed isArchived viewerPermission viewerDefaultMergeMethod
    pullRequest(number: $number) {
      id headRefName baseRefName headRef { name } reviewDecision mergeStateStatus isMergeQueueEnabled isCrossRepository
      viewerCanUpdate viewerCanUpdateBranch viewerCanClose viewerCanReopen viewerCanLabel viewerCanAssign viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      autoMergeRequest { mergeMethod }
      baseRef { compare(headRef: $headRef) { behindBy } }
      mergeTitle: viewerMergeHeadlineText(mergeType: MERGE)
      mergeBody: viewerMergeBodyText(mergeType: MERGE)
      squashTitle: viewerMergeHeadlineText(mergeType: SQUASH)
      squashBody: viewerMergeBodyText(mergeType: SQUASH)
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;
const methods = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" } as const;
const PreferenceRow = Schema.Struct({
  merge_method: PullRequestMergeMethod,
  delete_branch: Schema.Int,
});
export const repositoryIdentity = (ref: PullRequestRef) => `${ref.host}/${ref.owner}/${ref.repo}`;

export const makeActionReads = Effect.gen(function* () {
  const api = yield* GitHubApi;
  const sql = yield* SqlClient.SqlClient;
  const preferences = (ref: PullRequestRef) =>
    sql`SELECT merge_method, delete_branch FROM pull_request_action_preferences WHERE repository = ${repositoryIdentity(ref)}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PreferenceRow))),
      Effect.map((rows): typeof PullRequestActionPreferences.Type => ({
        mergeMethod: rows[0]?.merge_method ?? null,
        deleteBranch: rows[0]?.delete_branch === 1,
      })),
    );
  const read = (accountId: AccountId, ref: PullRequestRef) =>
    Effect.gen(function* () {
      const { repository } = yield* api.graphql(accountId, QUERY, Response, {
        owner: ref.owner,
        name: ref.repo,
        number: ref.number,
        headRef: `refs/pull/${ref.number}/head`,
      });
      const pull = repository?.pullRequest;
      if (repository == null || pull == null)
        return yield* new GitHubRequestError({
          accountId,
          reason: "not-found",
          status: null,
          message: `${ref.owner}/${ref.repo}#${ref.number} wasn't found, or ${accountId} has no access to it.`,
        });
      const canWrite =
        !repository.isArchived &&
        ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission ?? "");
      const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup?.state;
      const protectedBranch =
        pull.isCrossRepository || pull.headRef === null
          ? true
          : yield* api
              .rest(
                accountId,
                `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/branches/${encodeURIComponent(pull.headRefName)}`,
                Schema.Struct({ protected: Schema.Boolean }),
              )
              .pipe(
                Effect.map((branch) => branch.protected),
                Effect.catchTag("GitHubRequestError", (error) =>
                  error.status === 404 ? Effect.succeed(true) : Effect.fail(error),
                ),
              );
      return {
        reviewDecision: pull.reviewDecision,
        actions: {
          nodeId: pull.id,
          mergeState: pull.mergeStateStatus,
          behindBy: pull.baseRef?.compare?.behindBy ?? null,
          mergeCapabilities: {
            merge: repository.mergeCommitAllowed,
            squash: repository.squashMergeAllowed,
            rebase: repository.rebaseMergeAllowed,
          },
          preferredMergeMethod: methods[repository.viewerDefaultMergeMethod],
          viewerPermissions: {
            update: !repository.isArchived && pull.viewerCanUpdate,
            merge: canWrite,
            triage:
              !repository.isArchived && (canWrite || repository.viewerPermission === "TRIAGE"),
            updateBranch: !repository.isArchived && pull.viewerCanUpdateBranch,
            close: !repository.isArchived && pull.viewerCanClose,
            reopen: !repository.isArchived && pull.viewerCanReopen,
            labels: !repository.isArchived && pull.viewerCanLabel,
            reviewers: !repository.isArchived && pull.viewerCanAssign,
            enableAutoMerge: !repository.isArchived && pull.viewerCanEnableAutoMerge,
            disableAutoMerge: !repository.isArchived && pull.viewerCanDisableAutoMerge,
          },
          checksState:
            rollup === undefined
              ? null
              : rollup === "SUCCESS"
                ? ("passing" as const)
                : rollup === "FAILURE" || rollup === "ERROR"
                  ? ("failing" as const)
                  : ("pending" as const),
          autoMergeAllowed: repository.autoMergeAllowed,
          autoMergeMethod:
            pull.autoMergeRequest === null ? null : methods[pull.autoMergeRequest.mergeMethod],
          mergeQueue: pull.isMergeQueueEnabled,
          isFork: pull.isCrossRepository,
          canDeleteBranch:
            canWrite &&
            !pull.isCrossRepository &&
            !protectedBranch &&
            pull.headRefName !== pull.baseRefName,
          mergeMessages: {
            merge: { title: pull.mergeTitle, body: pull.mergeBody },
            squash: { title: pull.squashTitle, body: pull.squashBody },
          },
          preferences: yield* preferences(ref),
        },
      };
    });
  return { read };
});
