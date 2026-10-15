import {
  type AccountId,
  FixerError,
  FixerStateError,
  type FixerTurnId,
  type PullRequestKey,
  type PullRequestRef,
  type PushAccess,
  refFromKey,
} from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubApi } from "../github/GitHubApi.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { RepoCache } from "../repo/RepoCache.ts";
import type { FixerRow, TurnRow } from "./fixerRows.ts";
import { type FixerState, repositoryOf, short } from "./fixerState.ts";
import { readPushAccess } from "./pushAccess.ts";
import type { Sessions } from "./sessions.ts";
import type { TurnQueue } from "./turnQueue.ts";

/**
 * Push (docs/internals/fix-agent.md "Push"): push access as GitHub reports it,
 * the push itself only while the branch is where the turn found it, and what
 * happens to the batch's comments after.
 */
export const makePushes = (state: FixerState, queue: TurnQueue, sessions: Sessions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* RepoCache;
    const api = yield* GitHubApi;
    const pullRequests = yield* PullRequests;
    const {
      appendActivity,
      commandTurn,
      dbFailures,
      notify,
      now,
      publish,
      returnDrafts,
      snapshotOf,
      transition,
    } = state;
    const { advance, enqueue } = queue;
    const { rebindOrKeep } = sessions;
    const accessCache = new Map<string, { readonly at: number; readonly access: PushAccess }>();

    /** Pushes a ready turn's commit, only if the branch is still where the turn found it. */
    const pushTurn = (key: PullRequestKey, turnId: FixerTurnId, auto = false) =>
      Effect.gen(function* () {
        const { row, fixer, outcome } = yield* commandTurn(key, turnId, "push");
        if (outcome._tag === "reject")
          return yield* new FixerStateError({ key, message: outcome.message });
        if (outcome._tag === "noop") return yield* snapshotOf(key);
        const ref = refFromKey(key);
        if (ref === null || row.commit_sha === null || row.head_sha === null)
          return yield* new FixerError({ message: "This fix has no commit to push." });
        const access = yield* pushAccessFor(fixer.account_id, ref, true);
        if (access._tag === "denied") return yield* new FixerError({ message: access.reason });
        const sha = row.commit_sha;
        const headSha = row.head_sha;
        const rebase = row.work._tag === "conflicts" && row.work.strategy === "rebase";
        if (!(yield* transition(turnId, ["ready"], { _tag: "pushing" })))
          return yield* snapshotOf(key);
        yield* publish(key);
        // Once the push leaves, its outcome is recorded even if the caller goes away.
        const result = yield* Effect.uninterruptible(
          repo
            .pushFix({
              ref,
              accountId: fixer.account_id,
              headRepo: access.repository,
              headRef: access.branch,
              sha,
              expected: headSha,
              lease: rebase,
            })
            .pipe(Effect.result),
        );
        if (result._tag === "Failure") {
          yield* transition(turnId, ["pushing"], { _tag: "ready" });
          yield* appendActivity(key, turnId, "error", result.failure.message);
          return yield* new FixerError({ message: result.failure.message });
        }
        const at = yield* now;
        if (result.success._tag === "moved") {
          const remote = result.success.remote;
          const message = `The branch moved${remote === null ? "" : ` to ${short(remote)}`} before the push, so prkit pushed nothing and is redoing it on the new head`;
          if (
            !(yield* transition(turnId, ["pushing"], {
              _tag: "discarded",
              reason: "moved",
              message,
            }))
          )
            return yield* snapshotOf(key);
          yield* repo.holdCommit(ref, turnId, null).pipe(Effect.ignore);
          yield* appendActivity(key, turnId, "note", message);
          // The redo runs on the session's agent, or the fallback when that one is off now.
          const bound = yield* rebindOrKeep(fixer);
          yield* enqueue(bound, row.work, "redo", {
            createdAt: row.created_at,
            startedBy: row.started_by,
            // The batch's drafts stay with the agent, now for the redo.
            prepare: (redoId) =>
              sql`UPDATE pending_comments SET fixer_turn_id = ${redoId} WHERE fixer_turn_id = ${turnId}`.pipe(
                Effect.asVoid,
              ),
          });
          return yield* snapshotOf(key);
        }
        yield* transition(turnId, ["pushing"], { _tag: "pushed", at });
        yield* repo.holdCommit(ref, turnId, null).pipe(Effect.ignore);
        yield* pullRequests.invalidate(key, fixer.account_id);
        accessCache.clear();
        yield* appendActivity(
          key,
          turnId,
          "note",
          `Pushed ${short(sha)} to ${access.branch}${auto ? " automatically" : ""}`,
        );
        yield* Effect.logInfo("Fix pushed").pipe(
          Effect.annotateLogs({
            turnId,
            sha,
            repository: access.repository,
            branch: access.branch,
            auto,
          }),
        );
        yield* afterPush(fixer, row, sha);
        if (auto) yield* notify(fixer, "Fixes pushed", `${short(sha)} is on ${access.branch}`);
        yield* advance(fixer.id);
        return yield* snapshotOf(key);
      }).pipe(Effect.catchTags(dbFailures));

    /** Drafts the fix covered are resolved by the agent; GitHub threads get an answer if asked. */
    const afterPush = (fixer: FixerRow, row: TurnRow, sha: string) =>
      Effect.gen(function* () {
        if (row.work._tag !== "fix") return;
        const report = row.report !== null && "perComment" in row.report ? row.report : null;
        const statusOf = (id: string) => report?.perComment.find((entry) => entry.commentId === id);
        const at = yield* now;
        for (const comment of row.work.comments) {
          const entry = statusOf(comment.id);
          const done = entry !== undefined && entry.status !== "skipped";
          if (comment.source._tag === "draft") {
            yield* sql`UPDATE pending_comments SET state = ${done ? "resolved-by-agent" : "draft"},
              fixer_turn_id = NULL, updated_at = ${at}
              WHERE id = ${comment.source.draftId} AND state = 'sent-to-agent'`;
            continue;
          }
          if (!row.work.replyAfterPush || !comment.source.canReply || !done) continue;
          const body = `${entry.status === "partly" ? "Partly addressed" : "Addressed"} in ${sha}: ${entry.note}`;
          yield* pullRequests
            .replyToThread(fixer.pr_key, fixer.account_id, comment.source.threadId, body)
            .pipe(
              Effect.andThen(
                appendActivity(
                  fixer.pr_key,
                  row.id,
                  "note",
                  `Replied on GitHub to the thread on ${comment.path}`,
                ),
              ),
              Effect.catchTag("ReviewCommentsError", (error) =>
                appendActivity(
                  fixer.pr_key,
                  row.id,
                  "error",
                  `Couldn't reply on GitHub to the thread on ${comment.path}: ${error.message}`,
                ),
              ),
            );
        }
        // Drafts nothing reported on go back to the owner.
        yield* returnDrafts(row.id);
      });

    /** Push access as GitHub reports it now, kept a minute so the panel doesn't spend the budget. */
    const pushAccessFor = (accountId: AccountId, ref: PullRequestRef, refresh = false) =>
      Effect.gen(function* () {
        const cacheKey = `${accountId}:${repositoryOf(ref)}#${ref.number}`;
        const cached = accessCache.get(cacheKey);
        const at = yield* Clock.currentTimeMillis;
        if (!refresh && cached !== undefined && at - cached.at < 60_000) return cached.access;
        const access = yield* readPushAccess(accountId, ref).pipe(
          Effect.provideService(GitHubApi, api),
          Effect.catchTag("GitHubRequestError", (error) =>
            Effect.fail(new FixerError({ message: error.message })),
          ),
        );
        accessCache.set(cacheKey, { at, access });
        return access;
      });

    const pushAccess = (key: PullRequestKey, accountId: AccountId) =>
      Effect.gen(function* () {
        const ref = refFromKey(key);
        if (ref === null)
          return yield* new FixerError({ message: "That doesn't look like a pull request." });
        return yield* pushAccessFor(accountId, ref);
      });

    return { pushTurn, pushAccess };
  });

export type Pushes = Effect.Success<ReturnType<typeof makePushes>>;
