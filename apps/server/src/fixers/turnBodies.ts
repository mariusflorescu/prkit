import { type FixerTurnId, refFromKey, type TurnScripts } from "@prkit/contracts";
import * as Effect from "effect/Effect";

import { AGENT_OFF } from "../agents/AgentProvider.ts";
import { Agents } from "../agents/Agents.ts";
import { RepoCache } from "../repo/RepoCache.ts";
import type { AgentRuns } from "./agentRuns.ts";
import type { ConflictTurn } from "./conflictTurn.ts";
import type { FixerRow, TurnRow, WorkRequest } from "./fixerRows.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { type FixerState, plural, repositoryOf, reportSummary, short } from "./fixerState.ts";
import { fixPrompt, revisePrompt } from "./prompt.ts";
import type { ScriptAccessReads } from "./scriptAccess.ts";
import type { Sessions } from "./sessions.ts";
import type { TurnLeftovers } from "./turnLeftovers.ts";
import type { TurnSteps } from "./turnSteps.ts";

/**
 * What each kind of turn does once it starts: fix a batch of comments, resolve
 * conflicts, revert a pushed merge, or change a ready result on request.
 */
export const makeTurnBodies = (
  state: FixerState,
  runs: AgentRuns,
  steps: TurnSteps,
  conflicts: ConflictTurn,
  sessions: Sessions,
  access: ScriptAccessReads,
  leftovers: TurnLeftovers,
) =>
  Effect.gen(function* () {
    const repo = yield* RepoCache;
    const agents = yield* Agents;
    const settings = yield* FixerSettingsStore;
    const { appendActivity, fail, fixerById, notify, publish, returnDrafts, transition, turnById } =
      state;
    const { resumeFor, untilReported } = runs;
    const { identityFor, recordHead, repoFailure, settleReady, targetOf } = steps;
    const { agentHeld, conflictsBody, recordConflicted, verifyResolution } = conflicts;
    const { end } = sessions;
    /** The turn's agent instance, which may have been turned off or removed since it was queued. */
    const agentFor = (turn: TurnRow) =>
      Effect.gen(function* () {
        const provider = yield* agents.get(turn.instance_id);
        if (provider === null) return yield* fail("agent-auth", AGENT_OFF);
        return provider;
      });

    const fixBody = (fixer: FixerRow, turn: TurnRow, work: Extract<WorkRequest, { _tag: "fix" }>) =>
      Effect.gen(function* () {
        const ref = refFromKey(fixer.pr_key);
        if (ref === null)
          return yield* fail("repository", "This pull request's key can't be read.");
        const provider = yield* agentFor(turn);
        const target = yield* targetOf(fixer, ref);
        if (target.state !== "open") return yield* end(fixer.pr_key, target.state);
        const identity = yield* identityFor(fixer);
        const prepared = yield* repo
          .prepareFix({
            fixerId: fixer.id,
            ref,
            accountId: fixer.account_id,
            baseRef: target.baseRef,
            needs: "head",
          })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        yield* recordHead(turn.id, target, prepared);
        if (!(yield* transition(turn.id, ["preparing"], { _tag: "running" }))) return;
        yield* appendActivity(
          fixer.pr_key,
          turn.id,
          "note",
          `Checked out ${short(prepared.headSha)} with ${plural(work.comments.length, "comment")} to fix`,
        );
        yield* publish(fixer.pr_key);
        const scripts = yield* access.forTurn(fixer.pr_key, turn.id, target, prepared.worktree);
        const resume = yield* resumeFor(fixer.pr_key, turn.id, fixer, provider, prepared.worktree);
        yield* untilReported(
          fixer,
          turn.id,
          { _tag: "fix" },
          {
            provider,
            cwd: prepared.worktree,
            checkout: prepared.checkout,
            scripts,
            resume,
            prompt: fixPrompt({
              target,
              headSha: prepared.headSha,
              comments: work.comments,
              note: work.note,
              scripts,
              redo: turn.trigger === "redo",
              resumed: resume !== null,
            }),
          },
        );
        // The agent had the checkout; refuse to build a commit from git metadata it changed.
        yield* repo.verifyCheckout(prepared.checkout);
        const reported = yield* turnById(turn.id);
        const report = reported?.report;
        const summary =
          report != null && "perComment" in report ? report.summary : "Address review comments";
        const sha = yield* repo
          .commitAll({
            checkout: prepared.checkout,
            parents: [prepared.headSha],
            message: summary,
            identity,
          })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        if (sha === null) {
          if (yield* transition(turn.id, ["running"], { _tag: "unchanged" })) {
            yield* returnDrafts(turn.id);
            yield* appendActivity(
              fixer.pr_key,
              turn.id,
              "note",
              "The agent changed nothing, so there is nothing to push",
            );
            yield* notify(fixer, "The agent changed nothing", reportSummary(report ?? null));
          }
          return;
        }
        const diff = yield* repo
          .diffBetween(prepared.checkout, prepared.headSha, sha)
          .pipe(Effect.catchTag("RepoError", repoFailure));
        const repositorySettings = yield* settings.get(repositoryOf(ref));
        yield* settleReady(fixer, turn.id, {
          ref,
          sha,
          parents: [prepared.headSha],
          message: summary,
          diff: { _tag: "commit", diff },
          title: "Fixes ready",
          autoPush: repositorySettings.pushAutomatically,
        });
      });

    const revertBody = (
      fixer: FixerRow,
      turn: TurnRow,
      work: Extract<WorkRequest, { _tag: "revert" }>,
    ) =>
      Effect.gen(function* () {
        const ref = refFromKey(fixer.pr_key);
        if (ref === null)
          return yield* fail("repository", "This pull request's key can't be read.");
        const target = yield* targetOf(fixer, ref);
        if (target.state !== "open") return yield* end(fixer.pr_key, target.state);
        const identity = yield* identityFor(fixer);
        const prepared = yield* repo
          .prepareFix({
            fixerId: fixer.id,
            ref,
            accountId: fixer.account_id,
            baseRef: target.baseRef,
            needs: "head",
            also: [work.sha, `${work.sha}^1`],
          })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        yield* recordHead(turn.id, target, prepared);
        if (
          !(yield* repo
            .isAncestor(prepared.checkout, work.sha, prepared.headSha)
            .pipe(Effect.catchTag("RepoError", repoFailure)))
        )
          return yield* fail(
            "checks",
            `The branch no longer has the merge ${short(work.sha)}, so there is nothing to revert.`,
          );
        if (!(yield* transition(turn.id, ["preparing"], { _tag: "running" }))) return;
        yield* repo
          .revertMerge(prepared.checkout, work.sha, identity)
          .pipe(Effect.catchTag("RepoError", (error) => fail("checks", error.message)));
        const message = `Revert "Merge ${target.baseRef} into ${target.headRef}"\n\nThis reverts merge commit ${work.sha}.`;
        const sha = yield* repo
          .commitAll({
            checkout: prepared.checkout,
            parents: [prepared.headSha],
            message,
            identity,
            // Undoing the merge brings back the links the branch had before it.
            linksFrom: [prepared.headSha, `${work.sha}^1`],
          })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        if (sha === null) {
          if (yield* transition(turn.id, ["running"], { _tag: "unchanged" }))
            yield* appendActivity(
              fixer.pr_key,
              turn.id,
              "note",
              "Reverting the merge changes nothing now",
            );
          return;
        }
        const diff = yield* repo
          .diffBetween(prepared.checkout, prepared.headSha, sha)
          .pipe(Effect.catchTag("RepoError", repoFailure));
        yield* settleReady(fixer, turn.id, {
          ref,
          sha,
          parents: [prepared.headSha],
          message,
          diff: { _tag: "commit", diff },
          title: "Revert ready",
          autoPush: false,
        });
      });

    const runTurn = (turnId: FixerTurnId) =>
      Effect.gen(function* () {
        const turn = yield* turnById(turnId);
        const fixer = turn === null ? null : yield* fixerById(turn.fixer_id);
        if (turn === null || fixer === null) return;
        yield* appendActivity(fixer.pr_key, turnId, "phase", "preparing-code");
        if (turn.work._tag !== "revert") {
          const provider = yield* agentFor(turn);
          const state = yield* provider.check;
          if (state._tag === "unavailable") {
            yield* agents.invalidate;
            return yield* fail("agent-auth", state.message);
          }
        }
        switch (turn.work._tag) {
          case "fix":
            return yield* fixBody(fixer, turn, turn.work);
          case "conflicts":
            return yield* conflictsBody(fixer, turn, turn.work);
          case "revert":
            return yield* revertBody(fixer, turn, turn.work);
        }
      });

    /** The owner asked for a change to a ready result: the same session edits it, prkit re-commits. */
    const reviseBody = (turnId: FixerTurnId, note: string) =>
      Effect.gen(function* () {
        const turn = yield* turnById(turnId);
        const fixer = turn === null ? null : yield* fixerById(turn.fixer_id);
        if (turn === null || fixer === null || turn.commit_sha === null || turn.head_sha === null)
          return;
        const ref = refFromKey(fixer.pr_key);
        if (ref === null) return;
        const commitSha = turn.commit_sha;
        const parents = turn.commit_parents ?? [turn.head_sha];
        /**
         * A change that didn't work out leaves the earlier result as it was. If something the
         * agent started may still be running, the checkout stays as it is and the change stops
         * at Needs you, like any other turn.
         */
        const keepEarlier = (message: string) =>
          Effect.gen(function* () {
            if ((yield* leftovers.pending(fixer.id)).length > 0)
              return yield* fail("checks", message);
            yield* repo.resetFix(ref, fixer.id, commitSha).pipe(Effect.ignore);
            if (yield* transition(turnId, ["running"], { _tag: "ready" }))
              yield* appendActivity(
                fixer.pr_key,
                turnId,
                "error",
                `${message} The earlier result is unchanged.`,
              );
          });
        const body = Effect.gen(function* () {
          const provider = yield* agentFor(turn);
          const identity = yield* identityFor(fixer);
          // Put the checkout back at the ready commit, rebuilding it if its git metadata
          // drifted, so this behaves like ensureWorktree rather than giving up.
          const co = yield* repo
            .ensureFixCheckout(ref, fixer.id, commitSha)
            .pipe(Effect.catchTag("RepoError", () => Effect.succeed(null)));
          if (co === null) return yield* keepEarlier("prkit's checkout of this result is gone.");
          // A change request runs under the decision its turn made; a turn from before prkit
          // recorded one runs no scripts.
          const scripts: TurnScripts = turn.scripts ?? {
            _tag: "blocked",
            reason: "this result was made before prkit checked who opened it",
          };
          const kind = turn.work._tag === "fix" ? "fix" : "conflicts";
          const files = turn.conflicted.filter((file) => !file.needsHuman).map((file) => file.path);
          yield* untilReported(
            fixer,
            turnId,
            kind === "fix" ? { _tag: "fix" } : { _tag: "conflicts", files },
            {
              provider,
              cwd: co.worktree,
              checkout: co,
              scripts,
              resume: fixer.session_id,
              prompt: revisePrompt({
                note,
                sha: commitSha,
                kind,
                ids:
                  turn.work._tag === "fix" ? turn.work.comments.map((comment) => comment.id) : [],
              }),
            },
          );
          // The agent had the checkout; refuse to build on git metadata it changed.
          yield* repo.verifyCheckout(co);
          if (kind === "conflicts") {
            const marked = yield* agentHeld(turnId, files);
            if (marked.length > 0 && turn.base_sha !== null) {
              yield* repo
                .checkoutFrom(co, turn.base_sha, marked)
                .pipe(Effect.catchTag("RepoError", repoFailure));
              yield* recordConflicted(
                fixer.pr_key,
                turnId,
                marked.map((file) => ({ path: file, needsHuman: true })),
              );
            }
            yield* verifyResolution(
              co,
              files.filter((file) => !marked.includes(file)),
            );
          }
          const reported = yield* turnById(turnId);
          const report = reported?.report;
          const strategy = turn.work._tag === "conflicts" ? turn.work.strategy : null;
          const message =
            report != null && "perComment" in report
              ? report.summary
              : strategy === "merge" && report != null && "perFile" in report
                ? `${(turn.commit_message ?? "").split("\n")[0] ?? ""}\n\n${report.summary.trim()}`
                : (turn.commit_message ?? "Address review comments");
          // A rebase's history ends at its last commit, so a change goes on top.
          const commitParents = strategy === "rebase" ? [commitSha] : parents;
          const sha = yield* repo
            .commitAll({ checkout: co, parents: commitParents, message, identity })
            .pipe(Effect.catchTag("RepoError", repoFailure));
          if (sha === null) {
            if (strategy === "rebase") return yield* keepEarlier("The agent changed nothing.");
            if (yield* transition(turnId, ["running"], { _tag: "unchanged" })) {
              yield* returnDrafts(turnId);
              yield* repo.holdCommit(ref, turnId, null).pipe(Effect.ignore);
              yield* appendActivity(
                fixer.pr_key,
                turnId,
                "note",
                "After the change, the fix changes nothing",
              );
            }
            return;
          }
          const conflicted = (yield* turnById(turnId))?.conflicted ?? [];
          const paths = conflicted.map((file) => file.path);
          const diff =
            turn.work._tag === "fix"
              ? {
                  _tag: "commit" as const,
                  diff: yield* repo.diffBetween(co, turn.head_sha ?? commitSha, sha),
                }
              : {
                  _tag: "resolution" as const,
                  ours: yield* repo.diffBetween(co, turn.head_sha ?? commitSha, sha, paths),
                  theirs: yield* repo.diffBetween(co, turn.base_sha ?? commitSha, sha, paths),
                };
          const repositorySettings = yield* settings.get(repositoryOf(ref));
          yield* settleReady(fixer, turnId, {
            ref,
            sha,
            parents: commitParents,
            message,
            diff,
            title: turn.work._tag === "fix" ? "Fixes updated" : "Resolution updated",
            autoPush:
              strategy !== "rebase" &&
              repositorySettings.pushAutomatically &&
              conflicted.every((file) => !file.needsHuman),
          });
        });
        // A failed change request never throws away the result the owner already had.
        yield* body.pipe(
          Effect.catchTags({
            TurnFailure: (failure) => keepEarlier(failure.message),
            RepoError: (error) => keepEarlier(error.message),
            LinkRefused: (error) => keepEarlier(error.message),
            GitTampered: (error) => keepEarlier(error.message),
          }),
        );
      });

    return { runTurn, reviseBody };
  });
