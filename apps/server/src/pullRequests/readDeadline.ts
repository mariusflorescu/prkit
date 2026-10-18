import type { AccountId } from "@prkit/contracts";
import * as Effect from "effect/Effect";

import { GitHubRequestError } from "../github/GitHubApi.ts";

/** A read that outlives its deadline fails like a dropped connection, with a message the user can act on. */
export const withDeadline =
  (accountId: AccountId, deadline: { name: string; ms: number; message: string }) =>
  <A, E, R>(read: Effect.Effect<A, E, R>) =>
    read.pipe(
      Effect.timeoutOrElse({
        duration: deadline.ms,
        orElse: () =>
          Effect.logWarning(`${deadline.name} reached its deadline`).pipe(
            Effect.annotateLogs({ accountId, timeoutMs: deadline.ms }),
            Effect.andThen(
              Effect.fail(
                new GitHubRequestError({
                  accountId,
                  reason: "network",
                  status: null,
                  message: deadline.message,
                }),
              ),
            ),
          ),
      }),
    );
