import {
  PullRequestActionError,
  PullRequestCandidates,
  pullRequestActionLabels,
  pullRequestActionReason,
  refFromKey,
  type AccountId,
  type PullRequestCommand,
  type PullRequestDetail,
  type PullRequestKey,
  type PullRequestActionResult,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { GitHubApi, GitHubRequestError } from "../github/GitHubApi.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { repositoryIdentity } from "./actionReads.ts";

const Empty = Schema.Struct({});
const METHODS = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" } as const;
const SIMPLE = {
  ready: "markPullRequestReadyForReview",
  draft: "convertPullRequestToDraft",
  close: "closePullRequest",
  reopen: "reopenPullRequest",
  "disable-auto-merge": "disablePullRequestAutoMerge",
} as const;
const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  head_branch: Schema.String,
  head_repository: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  pull_requests: Schema.Array(Schema.Struct({ number: Schema.Int })),
});
const RawReviewer = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.String,
});
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const UserPage = Schema.Struct({
  repository: Schema.Struct({
    assignableUsers: Schema.Struct({ nodes: Schema.Array(RawReviewer), pageInfo: PageInfo }),
  }),
});
const Label = PullRequestCandidates.fields.labels.value;

export const makeActions = (reads: {
  detail: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<PullRequestDetail, { readonly message: string }>;
  /** Past every cache; fails instead of answering with a cached detail. */
  current: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<PullRequestDetail, GitHubRequestError | { readonly message: string }>;
  invalidate: (key: PullRequestKey, accountId: AccountId) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const sql = yield* SqlClient.SqlClient;
    const withPull = makeKeyedGate<PullRequestKey>(1);
    const fail = (
      key: PullRequestKey,
      accountId: AccountId,
      reason: PullRequestActionError["reason"],
      message: string,
    ) => new PullRequestActionError({ key, accountId, reason, message });
    const fromGitHub = (key: PullRequestKey, accountId: AccountId, error: GitHubRequestError) => {
      const message = error.message;
      const reason =
        error.reason === "rate-limited"
          ? "rate-limited"
          : error.reason === "network"
            ? "network"
            : /checks|review|protected|policy|required|merge queue/i.test(message)
              ? "checks-required"
              : error.status === 409 ||
                  error.status === 422 ||
                  /conflict|head.*changed|expected.*oid|not mergeable/i.test(message)
                ? "conflict"
                : "not-permitted";
      return fail(key, accountId, reason, message);
    };
    const binding = (key: PullRequestKey, accountId: AccountId, requireOpen = true) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT account_id FROM open_pull_requests WHERE key = ${key}`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ account_id: Schema.String }))),
          ),
        );
        const ref = refFromKey(key);
        if (
          !ref ||
          !accountId.startsWith(`${ref.host}/`) ||
          (rows[0] !== undefined && rows[0].account_id !== accountId) ||
          (requireOpen && rows[0] === undefined)
        )
          return yield* fail(
            key,
            accountId,
            "not-permitted",
            "This action must use the account bound to the open pull request. Open it again and retry.",
          );
        return {
          ref,
          root: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
          pullPath: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`,
        };
      });
    const wrap =
      (key: PullRequestKey, accountId: AccountId) =>
      <A>(
        effect: Effect.Effect<
          A,
          PullRequestActionError | GitHubRequestError | Schema.SchemaError | SqlError
        >,
      ) =>
        effect.pipe(
          Effect.catchTags({
            GitHubRequestError: (error) => Effect.fail(fromGitHub(key, accountId, error)),
            SchemaError: () =>
              Effect.fail(
                fail(
                  key,
                  accountId,
                  "network",
                  "GitHub returned an unreadable action response. Refresh and retry.",
                ),
              ),
            SqlError: () =>
              Effect.fail(
                fail(
                  key,
                  accountId,
                  "network",
                  "Couldn't save pull request preferences. Retry or restart prkit.",
                ),
              ),
          }),
        );
    const isGitHubError = Schema.is(GitHubRequestError);
    const execute = (key: PullRequestKey, accountId: AccountId, command: PullRequestCommand) => {
      const currentError = (error: GitHubRequestError | { readonly message: string }) =>
        isGitHubError(error) ? error : fail(key, accountId, "network", error.message);
      return withPull(
        key,
        Effect.gen(function* () {
          const { ref, root, pullPath } = yield* binding(key, accountId);
          const detail = yield* reads.current(key, accountId).pipe(Effect.mapError(currentError));
          if ("expectedHeadSha" in command && command.expectedHeadSha !== detail.headSha)
            return yield* fail(
              key,
              accountId,
              "conflict",
              "The pull request changed after you opened this action. Refresh and review the new head before retrying.",
            );
          const reason = pullRequestActionReason(detail, command.kind);
          if (reason !== null)
            return yield* fail(
              key,
              accountId,
              command.kind === "merge" ? "checks-required" : "not-permitted",
              reason,
            );
          const nodeId = detail.actions.nodeId;
          let url: string | null = null;
          let warning: string | null = null;
          switch (command.kind) {
            case "ready":
            case "draft":
            case "close":
            case "reopen":
            case "disable-auto-merge":
              yield* api.graphql(
                accountId,
                `mutation($id: ID!) { ${SIMPLE[command.kind]}(input: { pullRequestId: $id }) { clientMutationId } }`,
                Empty,
                { id: nodeId },
              );
              break;
            case "merge":
            case "enable-auto-merge": {
              if (!detail.actions.mergeCapabilities[command.method])
                return yield* fail(
                  key,
                  accountId,
                  "not-permitted",
                  "This merge method is disabled by the repository.",
                );
              if (
                command.kind === "merge" &&
                command.deleteBranch &&
                !detail.actions.canDeleteBranch
              )
                return yield* fail(
                  key,
                  accountId,
                  "not-permitted",
                  "This branch cannot be deleted. It may be protected or belong to a fork.",
                );
              const deleteBranch =
                command.kind === "merge"
                  ? command.deleteBranch
                  : detail.actions.preferences.deleteBranch;
              yield* sql`INSERT INTO pull_request_action_preferences (repository, merge_method, delete_branch) VALUES (${repositoryIdentity(ref)}, ${command.method}, ${deleteBranch ? 1 : 0}) ON CONFLICT(repository) DO UPDATE SET merge_method = excluded.merge_method, delete_branch = excluded.delete_branch`;
              if (command.kind === "merge") {
                yield* api.graphql(
                  accountId,
                  `mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }`,
                  Empty,
                  {
                    input: {
                      pullRequestId: nodeId,
                      mergeMethod: METHODS[command.method],
                      expectedHeadOid: command.expectedHeadSha,
                      ...(command.method === "rebase"
                        ? {}
                        : { commitHeadline: command.title, commitBody: command.body }),
                    },
                  },
                );
                if (command.deleteBranch) {
                  warning = yield* Effect.gen(function* () {
                    const branch = yield* api.rest(
                      accountId,
                      `${root}/branches/${encodeURIComponent(detail.headBranch)}`,
                      Schema.Struct({
                        protected: Schema.Boolean,
                        commit: Schema.Struct({ sha: Schema.String }),
                      }),
                    );
                    if (branch.protected || branch.commit.sha !== command.expectedHeadSha)
                      return "Merged, but the branch changed or is protected. The branch was kept.";
                    yield* api.restWrite(
                      accountId,
                      "DELETE",
                      `${root}/git/refs/heads/${detail.headBranch.split("/").map(encodeURIComponent).join("/")}`,
                      Empty,
                    );
                    return null;
                  }).pipe(
                    Effect.catchTag("GitHubRequestError", (error) =>
                      Effect.succeed(
                        error.status === 404
                          ? null
                          : `Merged, but the branch could not be deleted. ${error.message}`,
                      ),
                    ),
                  );
                }
              } else {
                yield* api.graphql(
                  accountId,
                  `mutation($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }`,
                  Empty,
                  { input: { pullRequestId: nodeId, mergeMethod: METHODS[command.method] } },
                );
              }
              break;
            }
            case "update-branch":
              yield* api.graphql(
                accountId,
                `mutation($input: UpdatePullRequestBranchInput!) { updatePullRequestBranch(input: $input) { clientMutationId } }`,
                Empty,
                {
                  input: {
                    pullRequestId: nodeId,
                    expectedHeadOid: command.expectedHeadSha,
                    updateMethod: METHODS[command.method],
                  },
                },
              );
              break;
            case "revert": {
              const reverted = yield* api.graphql(
                accountId,
                `mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { url } } }`,
                Schema.Struct({
                  revertPullRequest: Schema.Struct({
                    revertPullRequest: Schema.Struct({ url: Schema.String }),
                  }),
                }),
                { id: nodeId },
              );
              url = reverted.revertPullRequest.revertPullRequest.url;
              break;
            }
            case "edit":
              yield* api.restWrite(accountId, "PATCH", pullPath, Empty, {
                title: command.title,
                body: command.body,
              });
              break;
            case "labels":
              yield* api.restWrite(
                accountId,
                "PUT",
                `${root}/issues/${ref.number}/labels`,
                Schema.Array(Label),
                { labels: command.labels },
              );
              break;
            case "reviewers":
              yield* api.restWrite(
                accountId,
                command.requested ? "POST" : "DELETE",
                `${pullPath}/requested_reviewers`,
                Empty,
                { reviewers: command.reviewers, team_reviewers: command.teams },
              );
              break;
            case "approve-workflows": {
              const pull = yield* api.rest(
                accountId,
                pullPath,
                Schema.Struct({
                  head: Schema.Struct({
                    sha: Schema.String,
                    ref: Schema.String,
                    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
                  }),
                }),
              );
              const headRepo = pull.head.repo?.full_name;
              if (headRepo === undefined || pull.head.sha !== command.expectedHeadSha)
                return yield* fail(
                  key,
                  accountId,
                  "conflict",
                  "The fork head changed or is no longer available. Refresh before approving workflows.",
                );
              const matchingHeads = yield* api.graphql(
                accountId,
                `query PrkitBranchPullRequests($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, states: OPEN, first: 100) { nodes { number headRefOid headRepository { nameWithOwner } } pageInfo { hasNextPage } } } }`,
                Schema.Struct({
                  repository: Schema.Struct({
                    pullRequests: Schema.Struct({
                      nodes: Schema.Array(
                        Schema.Struct({
                          number: Schema.Int,
                          headRefOid: Schema.String,
                          headRepository: Schema.NullOr(
                            Schema.Struct({ nameWithOwner: Schema.String }),
                          ),
                        }),
                      ),
                      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
                    }),
                  }),
                }),
                { owner: ref.owner, name: ref.repo, branch: pull.head.ref },
              );
              const heads = matchingHeads.repository.pullRequests;
              const exact = heads.nodes.filter(
                (head) =>
                  head.headRefOid === command.expectedHeadSha &&
                  head.headRepository?.nameWithOwner.toLowerCase() === headRepo.toLowerCase(),
              );
              if (
                heads.pageInfo.hasNextPage ||
                exact.length !== 1 ||
                exact[0]?.number !== ref.number
              )
                return yield* fail(
                  key,
                  accountId,
                  "conflict",
                  "This fork head belongs to more than one pull request, or GitHub could not establish its ownership. Approve workflows on GitHub instead.",
                );
              const runs: (typeof WorkflowRun.Type)[] = [];
              for (let page = 1; ; page++) {
                const response = yield* api.rest(
                  accountId,
                  `${root}/actions/runs?event=pull_request&head_sha=${encodeURIComponent(command.expectedHeadSha)}&per_page=100&page=${page}`,
                  Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) }),
                );
                runs.push(
                  ...response.workflow_runs.filter(
                    (run) =>
                      (run.status === "action_required" || run.conclusion === "action_required") &&
                      run.head_sha === command.expectedHeadSha &&
                      run.head_branch === pull.head.ref &&
                      run.head_repository?.full_name === headRepo &&
                      (run.pull_requests.length === 0 ||
                        run.pull_requests.some((pr) => pr.number === ref.number)),
                  ),
                );
                if (response.workflow_runs.length < 100) break;
              }
              if (runs.length === 0)
                return yield* fail(
                  key,
                  accountId,
                  "conflict",
                  "No workflows for this pull request head are waiting for approval.",
                );
              for (const run of runs) {
                const fresh = yield* reads
                  .current(key, accountId)
                  .pipe(Effect.mapError(currentError));
                if (
                  fresh.state !== "open" ||
                  fresh.headSha !== command.expectedHeadSha ||
                  !fresh.actions.isFork
                )
                  return yield* fail(
                    key,
                    accountId,
                    "conflict",
                    "The fork changed while approval was pending. Review the new head before approving workflows.",
                  );
                const current = yield* api.rest(
                  accountId,
                  `${root}/actions/runs/${run.id}`,
                  WorkflowRun,
                );
                if (
                  current.head_sha !== command.expectedHeadSha ||
                  current.head_branch !== pull.head.ref ||
                  (current.status !== "action_required" && current.conclusion !== "action_required")
                )
                  return yield* fail(
                    key,
                    accountId,
                    "conflict",
                    "A workflow changed while approval was pending. Refresh before approving workflows.",
                  );
                yield* api.restWrite(
                  accountId,
                  "POST",
                  `${root}/actions/runs/${run.id}/approve`,
                  Empty,
                );
              }
              break;
            }
          }
          return {
            message:
              command.kind === "merge"
                ? "Pull request merged"
                : command.kind === "edit"
                  ? "Pull request updated"
                  : command.kind === "labels"
                    ? "Labels updated"
                    : command.kind === "reviewers"
                      ? "Review requests updated"
                      : `${pullRequestActionLabels[command.kind]} completed`,
            url,
            warning,
          } satisfies PullRequestActionResult;
        }).pipe(wrap(key, accountId), Effect.ensuring(reads.invalidate(key, accountId))),
      );
    };
    const candidates = (key: PullRequestKey, accountId: AccountId) =>
      Effect.gen(function* () {
        const { ref, root } = yield* binding(key, accountId, false);
        const incomplete = () =>
          Effect.logWarning("GitHub action choices reached their pagination limit").pipe(
            Effect.annotateLogs({ key, accountId, maxPages: 30 }),
            Effect.andThen(
              Effect.fail(
                fail(
                  key,
                  accountId,
                  "network",
                  "GitHub couldn't load all action choices safely. Open the pull request on GitHub.",
                ),
              ),
            ),
          );
        const reviewers: PullRequestCandidates["reviewers"][number][] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        for (let pageNumber = 1; pageNumber <= 30; pageNumber++) {
          const page: typeof UserPage.Type = yield* api.graphql(
            accountId,
            `query PrkitAssignableUsers($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { assignableUsers(first: 100, after: $cursor) { nodes { login name avatarUrl } pageInfo { hasNextPage endCursor } } } }`,
            UserPage,
            { owner: ref.owner, name: ref.repo, cursor },
          );
          reviewers.push(...page.repository.assignableUsers.nodes);
          if (!page.repository.assignableUsers.pageInfo.hasNextPage) break;
          cursor = page.repository.assignableUsers.pageInfo.endCursor;
          if (pageNumber === 30 || cursor === null || cursors.has(cursor))
            return yield* incomplete();
          cursors.add(cursor);
        }
        const labels: PullRequestCandidates["labels"][number][] = [];
        for (let page = 1; page <= 30; page++) {
          const rows = yield* api.rest(
            accountId,
            `${root}/labels?per_page=100&page=${page}`,
            Schema.Array(Label),
          );
          labels.push(...rows);
          if (rows.length < 100) break;
          if (page === 30) return yield* incomplete();
        }
        const teams: PullRequestCandidates["teams"][number][] = [];
        const detail = yield* reads
          .detail(key, accountId)
          .pipe(Effect.mapError((error) => fail(key, accountId, "network", error.message)));
        if (detail.actions.viewerPermissions.triage) {
          for (let page = 1; page <= 30; page++) {
            const rows = yield* api.rest(
              accountId,
              `${root}/teams?per_page=100&page=${page}`,
              Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
            );
            teams.push(...rows);
            if (rows.length < 100) break;
            if (page === 30) return yield* incomplete();
          }
        }
        return { reviewers, teams, labels } satisfies PullRequestCandidates;
      }).pipe(
        Effect.interruptible,
        Effect.timeout("40 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.logWarning("GitHub action choices reached their deadline").pipe(
            Effect.annotateLogs({ key, accountId, timeoutMs: 40_000 }),
            Effect.andThen(
              Effect.fail(
                fail(
                  key,
                  accountId,
                  "network",
                  "GitHub took too long to load action choices. Try again.",
                ),
              ),
            ),
          ),
        ),
        wrap(key, accountId),
      );
    return { execute, candidates };
  });
