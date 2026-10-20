import {
  type ConflictStrategy,
  type FixerTurnId,
  type PullRequestKey,
  refFromKey,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { AGENT_OFF } from "../agents/AgentProvider.ts";
import { Agents } from "../agents/Agents.ts";
import { type Checkout, RepoCache } from "../repo/RepoCache.ts";
import { Reviews } from "../reviews/Reviews.ts";
import type { AgentRuns } from "./agentRuns.ts";
import { markerLines, needsHuman } from "./conflicts.ts";
import { encodeConflicted, type FixerRow, type TurnRow, type WorkRequest } from "./fixerRows.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { type FixerState, plural, repositoryOf, short } from "./fixerState.ts";
import { type Commit, conflictPrompt, nextStopPrompt } from "./prompt.ts";
import type { ScriptAccessReads } from "./scriptAccess.ts";
import type { Sessions } from "./sessions.ts";
import type { TurnQueue } from "./turnQueue.ts";
import type { TurnSteps } from "./turnSteps.ts";

const MAX_REBASE_STOPS = 30;

/**
 * Conflict resolution (docs/internals/fix-agent.md "Conflicts"): prkit merges or
 * rebases, keeps the base side of files a person must decide, lets the agent
 * resolve the rest, and checks the result before it commits.
 */
export const makeConflictTurn = (
  state: FixerState,
  queue: TurnQueue,
  runs: AgentRuns,
  steps: TurnSteps,
  sessions: Sessions,
  access: ScriptAccessReads,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* RepoCache;
    const agents = yield* Agents;
    const reviews = yield* Reviews;
    const settings = yield* FixerSettingsStore;
    const { appendActivity, contextDir, fail, fixerById, publish, transition, turnById } = state;
    const { endTurn } = queue;
    const { resumeFor, untilReported } = runs;
    const { identityFor, recordHead, repoFailure, settleReady, targetOf } = steps;
    const { end } = sessions;

    /** Conflict markers left in files, as the problems the owner or agent reads. */
    const markerProblems = (worktree: string, files: ReadonlyArray<string>) =>
      Effect.forEach(files, (file) =>
        fs.readFileString(path.join(worktree, file)).pipe(
          Effect.map((text) => {
            const at = markerLines(text);
            return at.length === 0
              ? []
              : [
                  `\`${file}\`: conflict markers remain at line${at.length === 1 ? "" : "s"} ${at.slice(0, 8).join(", ")}.`,
                ];
          }),
          // A file the resolution deleted has no markers.
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        ),
      ).pipe(Effect.map((problems) => problems.flat()));

    /** prkit's deterministic check before it commits a resolution. */
    const verifyResolution = (co: Checkout, files: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const problems = [
          ...(yield* markerProblems(co.worktree, files)),
          ...(yield* repo.diffCheck(co)),
        ];
        if (problems.length > 0)
          return yield* fail(
            "checks",
            `prkit's checks found ${plural(problems.length, "problem")} in the resolution, so nothing was committed: ${problems.slice(0, 5).join(" ")}`,
          );
      });

    /** The latest guide's overview, for an agent working out what each side meant. */
    const writeGuideContext = (key: PullRequestKey, turnId: FixerTurnId) =>
      reviews.guide(key, undefined).pipe(
        Effect.flatMap((revision) =>
          Effect.gen(function* () {
            const dir = path.join(contextDir, turnId);
            yield* fs.makeDirectory(dir, { recursive: true });
            const file = path.join(dir, "guide.md");
            const guide = revision.normalized;
            yield* fs.writeFileString(
              file,
              [
                `# prkit's guide (revision ${revision.revision}, at ${short(revision.headSha)})`,
                "",
                guide.summary,
                "",
                ...guide.steps.map((step, index) => `${index + 1}. ${step}`),
                "",
                ...guide.chapters.flatMap((chapter) => [
                  `## ${chapter.title}`,
                  chapter.body,
                  `Files: ${chapter.files.map((entry) => entry.path).join(", ")}`,
                  "",
                ]),
              ].join("\n"),
            );
            return file;
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

    /** Classifies conflicted files, keeps the base side of the ones a person must decide. */
    const sortConflicts = (
      co: Checkout,
      files: ReadonlyArray<{ readonly path: string; readonly kind: "text" | "binary" | "deleted" }>,
      strategy: ConflictStrategy,
    ) =>
      Effect.gen(function* () {
        const held = files.filter(needsHuman).map((file) => file.path);
        const agentFiles = files.filter((file) => !needsHuman(file)).map((file) => file.path);
        yield* repo.takeBase(co, held, strategy).pipe(Effect.catchTag("RepoError", repoFailure));
        return { held, agentFiles };
      });

    /** Adds this stop's files to the turn's conflicted list; later entries win. */
    const recordConflicted = (
      key: PullRequestKey,
      turnId: FixerTurnId,
      files: ReadonlyArray<{ readonly path: string; readonly needsHuman: boolean }>,
    ) =>
      Effect.gen(function* () {
        const turn = yield* turnById(turnId);
        const merged = new Map((turn?.conflicted ?? []).map((file) => [file.path, file]));
        for (const file of files) merged.set(file.path, file);
        yield* sql`UPDATE fixer_turns SET conflicted = ${encodeConflicted([...merged.values()])} WHERE id = ${turnId}`;
        yield* publish(key);
      });

    /** Files the agent itself marked needs-human, which then keep the base side too. */
    const agentHeld = (turnId: FixerTurnId, files: ReadonlyArray<string>) =>
      turnById(turnId).pipe(
        Effect.map((turn) => {
          const report = turn?.report;
          if (report == null || !("perFile" in report)) return [];
          return report.perFile
            .filter((entry) => entry.resolution === "needs-human" && files.includes(entry.path))
            .map((entry) => entry.path);
        }),
      );

    const conflictsBody = (
      fixer: FixerRow,
      turn: TurnRow,
      work: Extract<WorkRequest, { _tag: "conflicts" }>,
    ) =>
      Effect.gen(function* () {
        const ref = refFromKey(fixer.pr_key);
        if (ref === null)
          return yield* fail("repository", "This pull request's key can't be read.");
        const provider = yield* agents.get(turn.instance_id);
        if (provider === null)
          return yield* fail(
            "agent-auth",
            (yield* agents.damagedMessage(turn.instance_id)) ?? AGENT_OFF,
          );
        const target = yield* targetOf(fixer, ref);
        if (target.state !== "open") return yield* end(fixer.pr_key, target.state);
        const identity = yield* identityFor(fixer);
        const prepared = yield* repo
          .prepareFix({
            fixerId: fixer.id,
            ref,
            accountId: fixer.account_id,
            baseRef: target.baseRef,
            needs: work.strategy,
          })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        yield* recordHead(turn.id, target, prepared);
        const { worktree, checkout: co, headSha, baseSha, mergeBaseSha } = prepared;
        const [ours, theirs] = yield* Effect.all([
          repo.logBetween(co, mergeBaseSha, headSha),
          repo.logBetween(co, mergeBaseSha, baseSha),
        ]).pipe(Effect.catchTag("RepoError", repoFailure));
        const scripts = yield* access.forTurn(
          fixer.pr_key,
          turn.id,
          target,
          worktree,
          provider.kind,
        );
        const guideFile = yield* writeGuideContext(fixer.pr_key, turn.id);
        const prompt = (input: {
          readonly files: ReadonlyArray<string>;
          readonly held: ReadonlyArray<string>;
          readonly replaying: Commit | null;
        }) =>
          conflictPrompt({
            target,
            strategy: work.strategy,
            headSha,
            baseSha,
            mergeBaseSha,
            ours,
            theirs,
            scripts,
            guideFile,
            redo: turn.trigger === "redo",
            ...input,
          });
        const cleanly = (message: string) =>
          endTurn(
            fixer,
            turn.id,
            { _tag: "discarded", reason: "upstream", message },
            ["preparing", "running"],
            { kind: "note", text: message },
          ).pipe(Effect.asVoid);

        /** One stop: hold what a person decides, let the agent resolve the rest, check it. */
        const resolveStop = (
          files: ReadonlyArray<{
            readonly path: string;
            readonly kind: "text" | "binary" | "deleted";
          }>,
          first: boolean,
          replaying: Commit | null,
        ) =>
          Effect.gen(function* () {
            const { held, agentFiles } = yield* sortConflicts(co, files, work.strategy);
            yield* recordConflicted(fixer.pr_key, turn.id, [
              ...held.map((file) => ({ path: file, needsHuman: true })),
              ...agentFiles.map((file) => ({ path: file, needsHuman: false })),
            ]);
            if (first && !(yield* transition(turn.id, ["preparing"], { _tag: "running" })))
              return false;
            yield* appendActivity(
              fixer.pr_key,
              turn.id,
              "note",
              `${replaying === null ? "Merged" : `Replaying ${short(replaying.sha)} stopped:`} ${plural(files.length, "conflicted file")}${held.length > 0 ? `, ${held.length} kept on the base side for you` : ""}`,
            );
            if (agentFiles.length > 0) {
              const session = (yield* fixerById(fixer.id)) ?? fixer;
              const resume = first
                ? yield* resumeFor(fixer.pr_key, turn.id, session, provider, worktree)
                : session.session_id;
              yield* untilReported(
                fixer,
                turn.id,
                { _tag: "conflicts", files: agentFiles },
                {
                  provider,
                  cwd: worktree,
                  checkout: co,
                  scripts,
                  resume,
                  prompt:
                    first || replaying === null
                      ? prompt({ files: agentFiles, held, replaying })
                      : nextStopPrompt({ replaying, files: agentFiles, held }),
                },
              );
              // The agent had the checkout; refuse to build on git metadata it changed.
              yield* repo.verifyCheckout(co);
              const marked = yield* agentHeld(turn.id, agentFiles);
              if (marked.length > 0) {
                yield* repo
                  .takeBase(co, marked, work.strategy)
                  .pipe(Effect.catchTag("RepoError", repoFailure));
                yield* recordConflicted(
                  fixer.pr_key,
                  turn.id,
                  marked.map((file) => ({ path: file, needsHuman: true })),
                );
              }
            }
            yield* verifyResolution(
              co,
              agentFiles.filter((file) => !held.includes(file)),
            );
            return true;
          });

        if (work.strategy === "merge") {
          const merged = yield* repo
            .mergeBase(co, baseSha, identity)
            .pipe(Effect.catchTag("RepoError", repoFailure));
          if (merged._tag !== "conflicts")
            return yield* cleanly(
              `The branch merges with ${target.baseRef} cleanly now, so there is nothing to resolve`,
            );
          if (!(yield* resolveStop(merged.files, true, null))) return;
          const reported = yield* turnById(turn.id);
          const report = reported?.report;
          const summary = report != null && "perFile" in report ? report.summary.trim() : "";
          const message = `Merge ${target.baseRef} into ${target.headRef}${summary === "" ? "" : `\n\n${summary}`}`;
          const sha = yield* repo
            .commitAll({ checkout: co, parents: [headSha, baseSha], message, identity })
            .pipe(Effect.catchTag("RepoError", repoFailure));
          if (sha === null) return yield* cleanly("The merge changes nothing on the branch");
          const conflicted = (yield* turnById(turn.id))?.conflicted ?? [];
          const paths = conflicted.map((file) => file.path);
          const [oursDiff, theirsDiff] = yield* Effect.all([
            repo.diffBetween(co, headSha, sha, paths),
            repo.diffBetween(co, baseSha, sha, paths),
          ]).pipe(Effect.catchTag("RepoError", repoFailure));
          const repositorySettings = yield* settings.get(repositoryOf(ref));
          return yield* settleReady(fixer, turn.id, {
            ref,
            sha,
            parents: [headSha, baseSha],
            message,
            diff: { _tag: "resolution", ours: oursDiff, theirs: theirsDiff },
            title: "Conflicts resolved",
            // A file a person must decide never goes out without a click.
            autoPush:
              repositorySettings.pushAutomatically && conflicted.every((file) => !file.needsHuman),
          });
        }

        let step = yield* repo
          .rebaseOnto(co, { baseSha, mergeBaseSha, identity })
          .pipe(Effect.catchTag("RepoError", repoFailure));
        let stops = 0;
        if (
          step._tag === "done" &&
          !(yield* transition(turn.id, ["preparing"], { _tag: "running" }))
        )
          return;
        while (step._tag === "stopped") {
          stops++;
          if (stops > MAX_REBASE_STOPS)
            return yield* fail(
              "checks",
              `The rebase stopped on more than ${MAX_REBASE_STOPS} commits. Merge the base instead.`,
            );
          if (!(yield* resolveStop(step.files, stops === 1, step.commit))) return;
          step = yield* repo
            .rebaseContinue(co, identity, step.plan)
            .pipe(Effect.catchTag("RepoError", repoFailure));
        }
        const head = step.head;
        const conflicted = (yield* turnById(turn.id))?.conflicted ?? [];
        const paths = conflicted.map((file) => file.path);
        const [oursDiff, theirsDiff] = yield* Effect.all([
          repo.diffBetween(co, headSha, head, paths),
          repo.diffBetween(co, baseSha, head, paths),
        ]).pipe(Effect.catchTag("RepoError", repoFailure));
        yield* settleReady(fixer, turn.id, {
          ref,
          sha: head,
          parents: [baseSha],
          message: `Rebase ${target.headRef} onto ${target.baseRef}`,
          diff: { _tag: "resolution", ours: oursDiff, theirs: theirsDiff },
          title: "Rebase ready",
          // A rebase rewrites history: its force-push is always a click.
          autoPush: false,
        });
      });

    return { markerProblems, verifyResolution, recordConflicted, agentHeld, conflictsBody };
  });

export type ConflictTurn = Effect.Success<ReturnType<typeof makeConflictTurn>>;
