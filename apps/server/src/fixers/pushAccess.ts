import type { AccountId, PullRequestRef, PushAccess } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubApi } from "../github/GitHubApi.ts";

const Permission = Schema.NullOr(Schema.String);
export const PushRead = Schema.Struct({
  viewer: Schema.Struct({ login: Schema.String }),
  repository: Schema.Struct({
    viewerPermission: Permission,
    pullRequest: Schema.NullOr(
      Schema.Struct({
        state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
        headRefName: Schema.String,
        isCrossRepository: Schema.Boolean,
        maintainerCanModify: Schema.Boolean,
        headRepository: Schema.NullOr(
          Schema.Struct({
            nameWithOwner: Schema.String,
            isArchived: Schema.Boolean,
            viewerPermission: Permission,
          }),
        ),
      }),
    ),
  }),
});
export type PushRead = typeof PushRead.Type;

const QUERY = `query PrkitPushAccess($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      state headRefName isCrossRepository maintainerCanModify
      headRepository { nameWithOwner isArchived viewerPermission }
    }
  }
}`;

const WRITES = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/**
 * Whether GitHub lets this account push to the PR's branch: write access to the
 * branch's repository, or, for a fork, write access to the base with the author
 * allowing maintainers to push.
 */
export const pushAccessOf = (read: PushRead): PushAccess => {
  const login = read.viewer.login;
  const pull = read.repository.pullRequest;
  if (pull === null) return { _tag: "denied", reason: "GitHub no longer has this pull request." };
  if (pull.state !== "OPEN") return { _tag: "denied", reason: "This pull request isn't open." };
  const head = pull.headRepository;
  if (head === null)
    return {
      _tag: "denied",
      reason: "The pull request's branch is gone: its repository was deleted.",
    };
  if (head.isArchived)
    return {
      _tag: "denied",
      reason: `${head.nameWithOwner} is archived, so nothing can be pushed.`,
    };
  const allowed = {
    _tag: "allowed",
    repository: head.nameWithOwner,
    branch: pull.headRefName,
  } as const;
  if (WRITES.has(head.viewerPermission ?? "")) return allowed;
  if (pull.isCrossRepository && WRITES.has(read.repository.viewerPermission ?? ""))
    return pull.maintainerCanModify
      ? allowed
      : {
          _tag: "denied",
          reason: `This pull request comes from ${head.nameWithOwner}, and its author doesn't allow maintainers to push to it.`,
        };
  return { _tag: "denied", reason: `${login} can't push to ${head.nameWithOwner}.` };
};

/** Reads push access through the PR's own account. */
export const readPushAccess = (accountId: AccountId, ref: PullRequestRef) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const read = yield* api.graphql(accountId, QUERY, PushRead, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    });
    return pushAccessOf(read);
  });
