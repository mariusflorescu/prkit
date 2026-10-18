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

/** The checks of one commit that haven't passed, each in the detail's order. */
export interface ContextChecks {
  readonly failing: ReadonlyArray<PullRequestCheck>;
  readonly pending: ReadonlyArray<PullRequestCheck>;
}

/** What GitHub says about a PR besides its diff, for one head commit. Every string in it came from GitHub users or CI. */
export interface PullRequestContext {
  readonly checks: ContextPart<ContextChecks>;
  /** Unresolved review threads, outdated ones included. */
  readonly threads: ContextPart<ReadonlyArray<ReviewThread>>;
  /** The issues the PR says it closes, as GitHub lists them. `total` is GitHub's count. */
  readonly issues: ContextPart<ClosingIssues>;
}

/** Each read answers from GitHub or from a read of the last few minutes, never from an older one. */
interface ContextReads {
  readonly checks: (
    key: PullRequestKey,
    accountId: AccountId,
  ) => Effect.Effect<Pick<PullRequestDetail, "headSha" | "checks">, PullRequestReadError>;
  /** The threads as numbered against `headSha`. */
  readonly threads: (
    key: PullRequestKey,
    accountId: AccountId,
    headSha: string,
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
 * A part never fails the guide and never holds it up for long: when GitHub can't answer in
 * time, the part says why. Interruption and defects still pass through. A part belongs to
 * the head the attempt fetched, so one read for another commit is unread rather than shown
 * against the wrong code.
 */
export const makePullRequestContext = (reads: ContextReads) => {
  const part = <A>(read: Effect.Effect<ContextPart<A>, PullRequestReadError>) =>
    read.pipe(
      Effect.catchTag("PullRequestReadError", (error) => Effect.succeed(unread(error))),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.succeed(unread({ message: "GitHub took too long to answer." })),
      }),
    );
  return (key: PullRequestKey, accountId: AccountId, headSha: string) =>
    Effect.all(
      {
        checks: part(
          reads.checks(key, accountId).pipe(
            Effect.map((detail): ContextPart<ContextChecks> =>
              detail.headSha !== headSha
                ? unread({ message: elsewhere("checks", detail.headSha, headSha) })
                : {
                    _tag: "read",
                    value: {
                      failing: detail.checks.filter((check) => check.status === "failing"),
                      pending: detail.checks.filter((check) => check.status === "pending"),
                    },
                  },
            ),
          ),
        ),
        threads: part(
          reads
            .threads(key, accountId, headSha)
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
