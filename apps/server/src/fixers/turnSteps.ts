import type { AccountId, FixerTurnId, PullRequestRef } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { type CommitIdentity, RepoCache } from "../repo/RepoCache.ts";
import { type ReviewTarget, reviewTarget } from "../reviews/reviewTarget.ts";
import { encodeDiff, encodeParents, type FixerRow } from "./fixerRows.ts";
import { type FixerState, reportSummary, short } from "./fixerState.ts";
import type { Pushes } from "./pushes.ts";
import { pushesItself } from "./turnRules.ts";

const UserProfile = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
});

/**
 * The git work every kind of turn shares: the PR as GitHub has it, who prkit
 * commits as, and settling a ready commit.
 */
export const makeTurnSteps = (state: FixerState, pushes: Pushes) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* RepoCache;
    const accounts = yield* GitHubAccounts;
    const api = yield* GitHubApi;
    const { appendActivity, fail, notify, titles, transition, turnById } = state;
    const { pushTurn } = pushes;
    const identities = new Map<AccountId, CommitIdentity>();

    /** Who prkit's commits are by: the PR's account, with GitHub's private noreply address. */
    const identityOf = (accountId: AccountId) =>
      Effect.gen(function* () {
        const known = identities.get(accountId);
        if (known !== undefined) return known;
        const profile = yield* api.rest(accountId, "/user", UserProfile);
        const identity = {
          name: profile.name ?? profile.login,
          email: `${profile.id}+${profile.login}@users.noreply.github.com`,
        };
        identities.set(accountId, identity);
        return identity;
      });

    /** Shared by every body: the PR as GitHub has it, through the fixer's own account. */
    const targetOf = (fixer: FixerRow, ref: PullRequestRef) =>
      Effect.gen(function* () {
        yield* accounts
          .list()
          .pipe(Effect.catchTag("AccountsError", (error) => fail("account", error.message)));
        const target = yield* reviewTarget(ref, fixer.account_id).pipe(
          Effect.provideService(GitHubApi, api),
          Effect.catchTag("GitHubRequestError", (error) =>
            fail(error.reason === "unauthorized" ? "account" : "github", error.message),
          ),
        );
        titles.set(fixer.pr_key, target.title);
        return target;
      });

    const identityFor = (fixer: FixerRow) =>
      identityOf(fixer.account_id).pipe(
        Effect.catchTag("GitHubRequestError", (error) =>
          fail(error.reason === "unauthorized" ? "account" : "github", error.message),
        ),
      );

    const repoFailure = (error: {
      readonly reason: "account" | "repository";
      readonly message: string;
    }) => fail(error.reason, error.message);

    /** Records the head and base a turn builds on, once fetched. */
    const recordHead = (
      turnId: FixerTurnId,
      target: ReviewTarget,
      prepared: { readonly headSha: string; readonly baseSha: string },
    ) =>
      sql`UPDATE fixer_turns SET head_sha = ${prepared.headSha}, base_sha = ${prepared.baseSha},
        head_ref = ${target.headRef}, base_ref = ${target.baseRef}, head_repo = ${target.headRepo}
        WHERE id = ${turnId}`;

    /** A commit is ready for the owner: keep it reachable, say so, and push it if the repository allows. */
    const settleReady = (
      fixer: FixerRow,
      turnId: FixerTurnId,
      input: {
        readonly ref: PullRequestRef;
        readonly sha: string;
        readonly parents: ReadonlyArray<string>;
        readonly message: string;
        readonly diff: Parameters<typeof encodeDiff>[0];
        readonly title: string;
        readonly autoPush: boolean;
      },
    ) =>
      Effect.gen(function* () {
        yield* repo
          .holdCommit(input.ref, turnId, input.sha)
          .pipe(Effect.catchTag("RepoError", repoFailure));
        yield* sql`UPDATE fixer_turns SET commit_sha = ${input.sha}, commit_parents = ${encodeParents(input.parents)},
          commit_message = ${input.message}, diff = ${encodeDiff(input.diff)}, narration = NULL WHERE id = ${turnId}`;
        if (!(yield* transition(turnId, ["running"], { _tag: "ready" }))) return;
        const turn = yield* turnById(turnId);
        yield* appendActivity(
          fixer.pr_key,
          turnId,
          "note",
          `Committed ${short(input.sha)}. Review it, then push`,
        );
        if (turn !== null && pushesItself(input.autoPush, turn.started_by)) {
          const pushed = yield* pushTurn(fixer.pr_key, turnId, true).pipe(
            Effect.as(true),
            Effect.catchTags({
              FixerError: (error) =>
                appendActivity(
                  fixer.pr_key,
                  turnId,
                  "error",
                  `Couldn't push automatically: ${error.message}`,
                ).pipe(Effect.as(false)),
              FixerStateError: () => Effect.succeed(false),
            }),
          );
          if (pushed) return;
        }
        yield* notify(fixer, input.title, reportSummary(turn === null ? null : turn.report));
      });

    return { targetOf, identityFor, repoFailure, recordHead, settleReady };
  });

export type TurnSteps = Effect.Success<ReturnType<typeof makeTurnSteps>>;
