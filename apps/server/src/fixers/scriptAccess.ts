import {
  type AccountId,
  type AgentProviderKind,
  FixerError,
  type FixerTurnId,
  type PullRequestKey,
  type PullRequestRef,
  refFromKey,
  type ScriptAccess,
  TurnScripts,
} from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { checkScripts, type ScriptRuns } from "../agents/bashPolicy.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { type ReviewTarget, reviewTarget } from "../reviews/reviewTarget.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { type FixerState, repositoryOf } from "./fixerState.ts";

const PackageScripts = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
);
const encodeScripts = Schema.encodeSync(Schema.fromJsonString(TurnScripts));

/** GitHub's `authorAssociation` for authors who can write to the base repository. */
const TRUSTED: Readonly<Record<string, (author: string, repository: string) => string>> = {
  OWNER: (author, repository) => `its author, ${author}, owns ${repository}`,
  MEMBER: (author, repository) =>
    `its author, ${author}, is a member of ${repository.slice(0, repository.indexOf("/"))}`,
  COLLABORATOR: (author, repository) => `its author, ${author}, is a collaborator on ${repository}`,
};

/**
 * Whether the fix agent may run the repository's check scripts on a pull request
 * (docs/internals/fix-agent.md "What the agent may do"). Their commands come from
 * the PR head's package.json, so they are the PR author's code: they run only when
 * the PR comes from the repository itself and its author is the owner or can write
 * to it, unless the owner allowed every pull request in the repository.
 */
export const decideScripts = (input: {
  readonly target: Pick<ReviewTarget, "author" | "authorAssociation" | "headRepo" | "repository">;
  /** Every login prkit has on the PR's host: all of them are the owner's. */
  readonly ownLogins: ReadonlyArray<string>;
  /** The repository's "on any pull request" opt-in. */
  readonly anyPullRequest: boolean;
}): ScriptAccess => {
  const { target } = input;
  const repository = `${target.repository.owner}/${target.repository.name}`;
  if (input.anyPullRequest)
    return {
      _tag: "allowed",
      reason: `you allowed it on every pull request in ${repository}`,
    };
  if (target.headRepo === null)
    return { _tag: "blocked", reason: "it comes from a fork that no longer exists" };
  if (target.headRepo.toLowerCase() !== repository.toLowerCase())
    return { _tag: "blocked", reason: `it comes from a fork, ${target.headRepo}` };
  const author = target.author;
  if (author === null) return { _tag: "blocked", reason: "GitHub doesn't say who opened it" };
  if (input.ownLogins.some((login) => login.toLowerCase() === author.toLowerCase()))
    return { _tag: "allowed", reason: "you opened it" };
  const trusted = TRUSTED[target.authorAssociation];
  return trusted === undefined
    ? {
        _tag: "blocked",
        reason: `its author, ${author}, isn't a member or collaborator of ${repository}`,
      }
    : { _tag: "allowed", reason: trusted(author, repository) };
};

/**
 * Cursor runs a repository's scripts on no pull request: its SDK approves every command on its
 * own, so prkit can't hold one back, and a Cursor turn has no shell (agents/cursor/tools.ts).
 */
export const CURSOR_RUNS_NO_SCRIPTS = "Cursor runs no commands, only reads and edits files";

/** What the agent's shell policy needs from a turn's scripts. */
export const scriptRuns = (scripts: TurnScripts): ScriptRuns =>
  scripts._tag === "blocked"
    ? scripts
    : { _tag: "allowed", names: scripts.scripts.map((script) => script.name) };

/**
 * The trust decision for a turn, made from the PR as the turn just read it and
 * recorded on the turn, and for the Fixes panel before any turn runs.
 */
export const makeScriptAccess = (state: FixerState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const accounts = yield* GitHubAccounts;
    const api = yield* GitHubApi;
    const settings = yield* FixerSettingsStore;
    const { fail, publish } = state;
    const targets = new Map<string, { readonly at: number; readonly target: ReviewTarget }>();

    const decide = (ref: PullRequestRef, target: ReviewTarget) =>
      Effect.gen(function* () {
        const { accounts: known } = yield* accounts.list();
        const repository = yield* settings.get(repositoryOf(ref));
        return decideScripts({
          target,
          ownLogins: known
            .filter((account) => account.host === ref.host)
            .map((account) => account.login),
          anyPullRequest: repository.runScriptsOnAnyPullRequest,
        });
      });

    /** The repository's own check scripts and their commands, from the checkout's package.json. */
    const scriptsIn = (worktree: string) =>
      fs.readFileString(path.join(worktree, "package.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(PackageScripts)),
        Effect.map((parsed) => checkScripts(parsed.scripts ?? {})),
        Effect.orElseSucceed(() => []),
      );

    /** Decides for a turn that has the PR head checked out, and records it on the turn. */
    const forTurn = (
      key: PullRequestKey,
      turnId: FixerTurnId,
      target: ReviewTarget,
      worktree: string,
      kind: AgentProviderKind,
    ) =>
      Effect.gen(function* () {
        const access: ScriptAccess =
          kind === "cursor"
            ? { _tag: "blocked", reason: CURSOR_RUNS_NO_SCRIPTS }
            : yield* decide(target.ref, target).pipe(
                Effect.catchTag("AccountsError", (error) => fail("account", error.message)),
              );
        const scripts: TurnScripts =
          access._tag === "blocked" ? access : { ...access, scripts: yield* scriptsIn(worktree) };
        yield* sql`UPDATE fixer_turns SET scripts = ${encodeScripts(scripts)} WHERE id = ${turnId}`;
        yield* publish(key);
        return scripts;
      });

    /** The PR as GitHub has it, kept a minute so the Fixes panel doesn't spend the budget. */
    const targetFor = (ref: PullRequestRef, accountId: AccountId) =>
      Effect.gen(function* () {
        const cacheKey = `${accountId}:${repositoryOf(ref)}#${ref.number}`;
        const at = yield* Clock.currentTimeMillis;
        const cached = targets.get(cacheKey);
        if (cached !== undefined && at - cached.at < 60_000) return cached.target;
        const target = yield* reviewTarget(ref, accountId).pipe(
          Effect.provideService(GitHubApi, api),
        );
        targets.set(cacheKey, { at, target });
        return target;
      });

    /** The decision the Fixes panel shows before a turn makes its own. */
    const forPullRequest = (key: PullRequestKey, accountId: AccountId) =>
      Effect.gen(function* () {
        const ref = refFromKey(key);
        if (ref === null)
          return yield* new FixerError({ message: "That doesn't look like a pull request." });
        return yield* decide(ref, yield* targetFor(ref, accountId));
      }).pipe(
        Effect.catchTags({
          GitHubRequestError: (error) => Effect.fail(new FixerError({ message: error.message })),
          AccountsError: (error) => Effect.fail(new FixerError({ message: error.message })),
        }),
      );

    return { forTurn, forPullRequest };
  });

export type ScriptAccessReads = Effect.Success<ReturnType<typeof makeScriptAccess>>;
