import {
  type AccountId,
  type GuideRepository,
  type PullRequestRef,
  repositoryIdOf,
  type StackMembership,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubApi } from "../github/GitHubApi.ts";
import { RestStack, restMembership } from "../pullRequests/stackQuery.ts";

const PullResponse = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.NullOr(Schema.String),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  author_association: Schema.String,
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      owner: Schema.Struct({ login: Schema.String }),
    }),
  }),
  stack: RestStack,
});

/** What a review needs to know about its PR from GitHub. The watcher reads it too. */
export interface ReviewTarget {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: string | null;
  /** The author's relation to the base repository, as GitHub names it: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ... */
  readonly authorAssociation: string;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  readonly headRef: string;
  /** `owner/repo` the head branch lives in; differs from the base repo for forks. */
  readonly headRepo: string | null;
  readonly baseSha: string;
  readonly baseRef: string;
  /** The base repository by GitHub's id, which survives renames and transfers. */
  readonly repository: GuideRepository;
  readonly stack: StackMembership | null;
}

/** Reads the PR through the review's own account, never another one. */
export const reviewTarget = (ref: PullRequestRef, accountId: AccountId) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const pull = yield* api.rest(
      accountId,
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      PullResponse,
    );
    return {
      ref,
      title: pull.title,
      body: pull.body ?? "",
      url: pull.html_url,
      author: pull.user?.login ?? null,
      authorAssociation: pull.author_association,
      state: pull.merged_at !== null ? "merged" : pull.state,
      headSha: pull.head.sha,
      headRef: pull.head.ref,
      headRepo: pull.head.repo?.full_name ?? null,
      baseSha: pull.base.sha,
      baseRef: pull.base.ref,
      repository: {
        id: repositoryIdOf(ref.host, pull.base.repo.id),
        host: ref.host,
        owner: pull.base.repo.owner.login,
        name: pull.base.repo.name,
      },
      stack: restMembership(pull.stack),
    } satisfies ReviewTarget;
  });
