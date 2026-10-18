import {
  type AccountId,
  type PullRequestCheck,
  type PullRequestKey,
  type PullRequestRef,
  refFromKey,
} from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import * as ServerConfig from "../config.ts";
import { GitHubApi, type GraphQLError, graphQLFailure, inBackground } from "../github/GitHubApi.ts";
import {
  FingerprintResponse,
  fingerprintQuery,
  pullRequestState,
} from "../pullRequests/fingerprint.ts";
import { CheckRun, Status, shownCheckRuns, shownStatuses } from "../pullRequests/detailReads.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { Workspace } from "../workspace/Workspace.ts";
import type { Observation } from "./lifecycle.ts";
import { Reviews, type WatchedReview } from "./Reviews.ts";

/** At most this many PRs per GraphQL request. */
const BATCH_SIZE = 50;
/** Closed and merged tabs, and failed reviews, are read this often. */
const SLOW_MS = 15 * 60_000;
/** The active PR's pending checks are asked about this often; a 304 costs nothing. */
const CHECKS_MS = 15_000;

const aliasProblem = (accountId: AccountId, error: GraphQLError | undefined) => {
  if (error === undefined) return "GitHub answered without this pull request.";
  switch (graphQLFailure(error)) {
    case "not-found":
      return `This pull request wasn't found, or ${accountId} has no access to it.`;
    case "rate-limited":
      return `GitHub has rate limited ${accountId}.`;
    default:
      return `GitHub couldn't read this pull request: ${error.message}`;
  }
};

const decodeCheckRuns = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ check_runs: Schema.Array(CheckRun) })),
);
const decodeStatuses = Schema.decodeOption(Schema.fromJsonString(Schema.Array(Status)));
const signature = (checks: ReadonlyArray<PullRequestCheck>) =>
  checks
    .map((check) => `${check.id}:${check.status}`)
    .toSorted()
    .join(",");

/**
 * Whether the first answer for a head already differs from what the detail shows,
 * such as a check that finished between the detail's read and this one. A full page
 * isn't compared: the detail read more pages than this one.
 */
const differs = (
  kind: "check-runs" | "statuses",
  body: string,
  shown: ReadonlyArray<PullRequestCheck>,
) => {
  const now =
    kind === "check-runs"
      ? Option.map(decodeCheckRuns(body), (page) =>
          page.check_runs.length < 100 ? shownCheckRuns(page.check_runs) : null,
        )
      : Option.map(decodeStatuses(body), (page) =>
          page.length < 100 ? shownStatuses(page) : null,
        );
  const prefix = kind === "check-runs" ? "check-" : "status-";
  return Option.match(now, {
    onNone: () => false,
    onSome: (checks) =>
      checks !== null &&
      signature(checks) !== signature(shown.filter((check) => check.id.startsWith(prefix))),
  });
};

/** One PR the watcher reads, through the account bound to it. */
interface Target {
  readonly key: PullRequestKey;
  readonly accountId: AccountId;
  readonly ref: PullRequestRef;
  readonly review: WatchedReview | null;
  readonly slow: boolean;
}

/**
 * The one loop that reads GitHub on its own. Every tick it fingerprints, in one
 * aliased query per account: every review that is preparing, writing or watching, every open
 * PR tab while a window is visible, and (every 15 minutes) failed reviews and
 * closed or merged tabs. A changed fingerprint marks that PR's cached reads stale;
 * a review also learns about merges and new heads (docs/internals/architecture.md
 * "The watcher"). While visible it also keeps the inbox revalidated and, every 15
 * seconds, asks GitHub with ETags whether the active PR's pending checks moved.
 */
export class ReviewWatcher extends Context.Service<ReviewWatcher, Effect.Success<typeof make>>()(
  "@prkit/server/reviews/ReviewWatcher",
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const reviews = yield* Reviews;
  const accounts = yield* GitHubAccounts;
  const api = yield* GitHubApi;
  const pullRequests = yield* PullRequests;
  const workspace = yield* Workspace;
  const once = yield* Semaphore.make(1);
  const checkedAt = new Map<string, number>();
  const etags = new Map<string, string>();

  /** Each alias is handled on its own; one failed read doesn't touch the others. */
  const readBatch = (accountId: AccountId, batch: ReadonlyArray<Target>) =>
    Effect.gen(function* () {
      const { query, variables } = fingerprintQuery(batch.map((entry) => entry.ref));
      const read = yield* inBackground(
        api.graphqlResult(accountId, query, variables, FingerprintResponse),
      ).pipe(Effect.result);
      yield* Effect.forEach(
        batch,
        (entry, index) =>
          Effect.gen(function* () {
            const alias = `p${index}`;
            let observation: Observation;
            if (Result.isFailure(read)) {
              const error = read.failure;
              observation =
                error.reason === "unauthorized"
                  ? { _tag: "refused", message: error.message }
                  : { _tag: "unreadable", message: error.message };
            } else {
              const pull = read.success.data?.[alias]?.pullRequest;
              if (pull == null)
                observation = {
                  _tag: "unreadable",
                  message: aliasProblem(
                    accountId,
                    read.success.errors.find((error) => error.path?.[0] === alias) ??
                      read.success.errors[0],
                  ),
                };
              else {
                yield* pullRequests.observe(entry.key, accountId, pull);
                observation = {
                  _tag: "pull",
                  state: pullRequestState(pull),
                  headSha: pull.headRefOid,
                  baseRef: pull.baseRefName,
                };
              }
            }
            if (entry.review !== null) yield* reviews.observed(entry.review, observation);
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("Watcher couldn't apply a read", cause).pipe(
                  Effect.annotateLogs({ key: entry.key }),
                ),
            ),
          ),
        { discard: true },
      );
    });

  /** Reviews always; open tabs only while a window shows them. */
  const targets = Effect.gen(function* () {
    const visible = (yield* SubscriptionRef.get(pullRequests.presence)) > 0;
    const found = new Map<string, Target>();
    const add = (target: Target) => {
      const id = `${target.accountId}:${target.key}`;
      const known = found.get(id);
      found.set(id, {
        ...target,
        review: target.review ?? known?.review ?? null,
        slow: target.slow && (known?.slow ?? true),
      });
    };
    for (const review of yield* reviews.watched) {
      const ref = refFromKey(review.key);
      if (ref === null) continue;
      add({
        key: review.key,
        accountId: review.accountId,
        ref,
        review,
        slow: review.status._tag === "failed",
      });
    }
    if (visible)
      for (const row of (yield* workspace.get()).open) {
        const ref = refFromKey(row.key);
        if (ref === null) continue;
        const status = yield* pullRequests.statusFor(row.key, row.accountId);
        add({
          key: row.key,
          accountId: row.accountId,
          ref,
          review: null,
          slow: status !== undefined && status.state !== "open",
        });
      }
    return { visible, targets: [...found.values()] };
  });

  /** ETags: a 304 is free, so the active PR's pending checks are asked about often. */
  const checkActive = Effect.gen(function* () {
    if ((yield* SubscriptionRef.get(pullRequests.presence)) === 0) return;
    const { open, activeKey } = yield* workspace.get();
    const active = open.find((row) => row.key === activeKey);
    const ref = active === undefined ? null : refFromKey(active.key);
    if (active === undefined || ref === null) return;
    const cached = yield* pullRequests.cachedDetail(active.key, active.accountId);
    if (cached === undefined || cached.invalidated) return;
    const detail = cached.value;
    if (!detail.checks.some((check) => check.status === "pending")) return;
    const root = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    let moved = false;
    for (const kind of ["check-runs", "statuses"] as const) {
      const id = `${active.accountId}:${active.key}:${detail.headSha}:${kind}`;
      const known = etags.get(id) ?? null;
      const answer = yield* inBackground(
        api.restChanged(
          active.accountId,
          `${root}/commits/${detail.headSha}/${kind}?per_page=100`,
          known,
        ),
      );
      if (answer._tag === "unchanged") continue;
      if (answer.etag !== null) etags.set(id, answer.etag);
      if (known !== null || differs(kind, answer.body, detail.checks)) moved = true;
    }
    if (moved) yield* pullRequests.checksChanged(active.key, active.accountId);
  }).pipe(
    Effect.catchTags({
      GitHubRequestError: () => Effect.void,
      PullRequestReadError: () => Effect.void,
      WorkspaceError: () => Effect.void,
    }),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("Checking the active PR's checks failed", cause),
    ),
  );

  /** One pass: every PR that is due, grouped by its own account. */
  const tick = once
    .withPermits(1)(
      Effect.gen(function* () {
        const { visible, targets: all } = yield* targets;
        const now = yield* Clock.currentTimeMillis;
        const due = all.filter(
          (target) =>
            now - (checkedAt.get(`${target.accountId}:${target.key}`) ?? 0) >=
            (target.slow ? SLOW_MS : config.watchIntervalMs) * 0.9,
        );
        if (due.length > 0) {
          // Tokens are only handed out for discovered accounts.
          yield* accounts.list();
          const byAccount = new Map<AccountId, Array<Target>>();
          for (const target of due) {
            checkedAt.set(`${target.accountId}:${target.key}`, now);
            byAccount.set(target.accountId, [...(byAccount.get(target.accountId) ?? []), target]);
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
          yield* Effect.logDebug("Watcher read fingerprints").pipe(
            Effect.annotateLogs({ due: due.length, accounts: byAccount.size, visible }),
          );
        }
        if (!visible) return;
        yield* inBackground(pullRequests.inbox({ _tag: "cached" })).pipe(Effect.ignore);
      }),
    )
    .pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Watcher tick failed", cause),
      ),
    );

  // One fiber, ticks spaced from the end of the last, so they never overlap. Reviews
  // has reconciled by the time this layer builds. A window becoming visible ticks at
  // once; PRs read less than an interval ago are skipped.
  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.watchIntervalMs))),
    Effect.forkScoped,
  );
  // Checks move faster than anything the tick reads; nothing is sent while no window is
  // visible or no check of the active PR is pending.
  yield* checkActive.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(Math.min(CHECKS_MS, config.watchIntervalMs)))),
    Effect.forkScoped,
  );
  yield* SubscriptionRef.changes(pullRequests.presence).pipe(
    Stream.filter((count) => count > 0),
    Stream.runForEach(() => tick),
    Effect.forkScoped,
  );
  yield* Effect.logInfo("Watching reviews and open pull requests").pipe(
    Effect.annotateLogs({ intervalMs: config.watchIntervalMs }),
  );

  return { tick };
});

export const layer = Layer.effect(ReviewWatcher, make);
