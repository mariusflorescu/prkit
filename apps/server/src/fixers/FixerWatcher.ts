import {
  type AccountId,
  type PullRequestKey,
  type PullRequestRef,
  refFromKey,
} from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import * as ServerConfig from "../config.ts";
import { GitHubApi, inBackground } from "../github/GitHubApi.ts";
import {
  FingerprintResponse,
  fingerprintQuery,
  pullRequestState,
} from "../pullRequests/fingerprint.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { Workspace } from "../workspace/Workspace.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { Fixers } from "./Fixers.ts";
import type { FixerObservation } from "./fixWatch.ts";

/** At most this many PRs per GraphQL request. */
const BATCH_SIZE = 50;

/** `mergeStateStatus` as the fix agent reads it: DIRTY is a conflict; drafts and UNKNOWN say nothing. */
const mergeableOf = (status: string): FixerObservation["mergeable"] =>
  status === "DIRTY"
    ? "conflicting"
    : status === "UNKNOWN" || status === "DRAFT"
      ? "unknown"
      : "mergeable";

interface Watched {
  readonly key: PullRequestKey;
  readonly ref: PullRequestRef;
}

/**
 * Watches every PR with an active fix session, and every watched or open PR in a
 * repository that resolves conflicts automatically, for merged or closed PRs,
 * conflicts resolved elsewhere, and new conflicts (docs/internals/fix-agent.md).
 */
export class FixerWatcher extends Context.Service<FixerWatcher, Effect.Success<typeof make>>()(
  "@prkit/server/fixers/FixerWatcher",
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fixers = yield* Fixers;
  const reviews = yield* Reviews;
  const workspace = yield* Workspace;
  const settings = yield* FixerSettingsStore;
  const accounts = yield* GitHubAccounts;
  const api = yield* GitHubApi;
  const pullRequests = yield* PullRequests;

  /** Each PR once, read through the account bound to it. */
  const candidates = Effect.gen(function* () {
    const byKey = new Map<PullRequestKey, AccountId>();
    for (const fixer of yield* fixers.watched) byKey.set(fixer.pr_key, fixer.account_id);
    const automatic = yield* settings.autoResolving();
    if (automatic.size > 0) {
      const open = yield* workspace.get();
      const others = [
        ...(yield* reviews.watched).map((review) => [review.key, review.accountId] as const),
        ...open.open.map((row) => [row.key, row.accountId] as const),
      ];
      for (const [key, accountId] of others) {
        const ref = refFromKey(key);
        if (
          ref !== null &&
          automatic.has(`${ref.host}/${ref.owner}/${ref.repo}`) &&
          !byKey.has(key)
        )
          byKey.set(key, accountId);
      }
    }
    return byKey;
  });

  const readBatch = (accountId: AccountId, batch: ReadonlyArray<Watched>) =>
    Effect.gen(function* () {
      // The review watcher's own fingerprint, read as background work under the
      // reserve; every read also tells PullRequests, so its caches see our pushes.
      const { query, variables } = fingerprintQuery(batch.map((entry) => entry.ref));
      const read = yield* inBackground(
        api.graphqlResult(accountId, query, variables, FingerprintResponse),
      );
      yield* Effect.forEach(
        batch,
        (entry, index) => {
          const pull = read.data?.[`p${index}`]?.pullRequest;
          if (pull == null) return Effect.void;
          return pullRequests
            .observe(entry.key, accountId, pull)
            .pipe(
              Effect.andThen(
                fixers.observed(entry.key, accountId, {
                  state: pullRequestState(pull),
                  headSha: pull.headRefOid,
                  mergeable: mergeableOf(pull.mergeStateStatus),
                }),
              ),
            )
            .pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("Fix watcher couldn't apply a read", cause).pipe(
                    Effect.annotateLogs({ key: entry.key }),
                  ),
              ),
            );
        },
        { discard: true },
      );
    }).pipe(
      Effect.catchTag("GitHubRequestError", (error) =>
        Effect.logWarning("Fix watcher couldn't read pull requests").pipe(
          Effect.annotateLogs({ accountId, reason: error.reason }),
        ),
      ),
    );

  const tick = Effect.gen(function* () {
    const watched = yield* candidates;
    if (watched.size === 0) return;
    // Tokens are only handed out for discovered accounts.
    yield* accounts.list();
    const byAccount = new Map<AccountId, Array<Watched>>();
    for (const [key, accountId] of watched) {
      const ref = refFromKey(key);
      if (ref === null) continue;
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), { key, ref }]);
    }
    yield* Effect.forEach(
      byAccount,
      ([accountId, entries]) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(entries.length / BATCH_SIZE) }, (_, index) =>
            entries.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
          ),
          (batch) => readBatch(accountId, batch),
          { discard: true },
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("Fix watcher tick failed", cause),
    ),
  );

  // Ticks spaced from the end of the last, so they never overlap. Fixers has
  // reconciled by the time this layer builds.
  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.watchIntervalMs))),
    Effect.forkScoped,
  );
  return { tick };
});

export const layer = Layer.effect(FixerWatcher, make);
