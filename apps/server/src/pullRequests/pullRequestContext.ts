import type {
  AccountId,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestKey,
  PullRequestReadError,
  ReviewThread,
  ReviewThreads,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";

import type { ClosingIssues } from "./closingIssuesQuery.ts";

/** One part of what GitHub says about a PR besides its diff: what was read (maybe nothing), or why it couldn't be. */
export type ContextPart<A> =
  | { readonly _tag: "read"; readonly value: A }
  | { readonly _tag: "unread"; readonly message: string };

/** What GitHub says about a PR besides its diff, for one head commit. Every string in it came from GitHub users or CI. */
export interface PullRequestContext {
  /** Failing and pending checks of that commit, failing first, in the detail's order otherwise. */
  readonly checks: ContextPart<ReadonlyArray<PullRequestCheck>>;
  /** Unresolved review threads, outdated ones included. */
  readonly threads: ContextPart<ReadonlyArray<ReviewThread>>;
  /** The issues the PR says it closes, as GitHub lists them. `total` is GitHub's count. */
  readonly issues: ContextPart<ClosingIssues>;
}

interface ContextReads {
  readonly detail: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<PullRequestDetail, PullRequestReadError>;
  readonly threads: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<ReviewThreads, PullRequestReadError>;
  readonly closingIssues: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<ClosingIssues, PullRequestReadError>;
}

const elsewhere = (what: string, read: string, head: string) =>
  `GitHub's ${what} were read for ${read.slice(0, 7)}, not for ${head.slice(0, 7)}, the commit this guide is written for, so they are left out.`;

const unread = (error: {
  readonly message: string;
}): { readonly _tag: "unread"; readonly message: string } => ({
  _tag: "unread",
  message: error.message,
});

/**
 * A part never fails the guide: when GitHub can't answer, the part says why. Interruption
 * and defects still pass through. A part belongs to the head the attempt fetched, so one
 * read for another commit is unread rather than shown against the wrong code.
 */
export const makePullRequestContext = (reads: ContextReads) => {
  const part = <A>(read: Effect.Effect<ContextPart<A>, PullRequestReadError>) =>
    read.pipe(Effect.catchTag("PullRequestReadError", (error) => Effect.succeed(unread(error))));
  return (key: PullRequestKey, accountId: AccountId, headSha: string) =>
    Effect.all(
      {
        checks: part(
          reads.detail(key, accountId).pipe(
            Effect.map((detail): ContextPart<ReadonlyArray<PullRequestCheck>> => {
              if (detail.freshness.problem !== null) return unread(detail.freshness.problem);
              if (detail.headSha !== headSha)
                return unread({ message: elsewhere("checks", detail.headSha, headSha) });
              const open = detail.checks.filter(
                (check) => check.status === "failing" || check.status === "pending",
              );
              return {
                _tag: "read",
                value: [
                  ...open.filter((check) => check.status === "failing"),
                  ...open.filter((check) => check.status === "pending"),
                ],
              };
            }),
          ),
        ),
        threads: part(
          reads
            .threads(key, accountId)
            .pipe(
              Effect.map((read): ContextPart<ReadonlyArray<ReviewThread>> =>
                read.headSha !== headSha
                  ? unread({ message: elsewhere("review threads", read.headSha, headSha) })
                  : { _tag: "read", value: read.threads.filter((thread) => !thread.resolved) },
              ),
            ),
        ),
        issues: part(
          reads
            .closingIssues(key, accountId)
            .pipe(Effect.map((value): ContextPart<ClosingIssues> => ({ _tag: "read", value }))),
        ),
      },
      { concurrency: 3 },
    );
};
