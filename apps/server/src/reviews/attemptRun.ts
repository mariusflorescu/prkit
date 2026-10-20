import {
  AttemptConfig,
  AttemptId,
  AttemptTrigger,
  DiffSnapshot,
  type DoneReason,
  everythingSkippedMessage,
  explicitModelOptions,
  findAgentModel,
  NormalizedGuide,
  projectSnapshot,
  ReviewKey,
  ReviewStateError,
  ReviewStatus,
  riskSignals,
  SKIPPED_CHAPTER_ID,
} from "@prkit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { turnTmpDir } from "../agents/commandReach.ts";
import { LocalCapture } from "../repo/localCapture.ts";
import { type Since } from "../repo/RepoCache.ts";
import { decide } from "./lifecycle.ts";
import { buildPrompt, NUDGE_PROMPT, numberedDiff, type PromptInput } from "./prompt.ts";
import {
  AttemptFailure,
  cacheOf,
  encodeOptions,
  encodeStatus,
  plural,
  type ReadyNotice,
  type ReviewStore,
  type StoredReview,
} from "./reviewStore.ts";
import { fail, type makeAttemptPlans, PreviousRow, type PullRequestFront } from "./attemptPlans.ts";
import { type makeAttemptTurn } from "./attemptTurn.ts";

export const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Int })),
);

/** The previous guide as the agent reads it: indented, so no line is too long to read. */
const encodeReadableGuide = Schema.encodeSync(
  Schema.fromJsonString(NormalizedGuide.mapFields(Struct.omit(["signals"])), { space: 2 }),
);

const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(DiffSnapshot));

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AttemptConfig));

const short = (sha: string) => sha.slice(0, 7);

/** The guide is current for this head and base; the base is null only for revisions from before stacks. */
const watchingAt = (headSha: string, baseRef: string | null, checkedAt: string): ReviewStatus =>
  baseRef === null
    ? { _tag: "watching", headSha, checkedAt }
    : { _tag: "watching", headSha, baseRef, checkedAt };

const ENDED: Record<DoneReason, string> = {
  merged: "The pull request was merged",
  closed: "The pull request was closed",
  stopped: "Stopped by the user",
};

/** What an attempt tells the user and the agent about the revision it follows. */
const following = (
  previous: { readonly revision: number; readonly head_sha: string } | null,
  since: Since,
  files: { readonly since: string; readonly guide: string },
  /** A local run: its commits are the author's, not the snapshot commits prkit made. */
  local: LocalCapture | null,
): {
  /** Replaces the attempt's trigger once the head is known; null keeps it. */
  readonly trigger: AttemptTrigger | null;
  readonly commits: number | null;
  readonly note: string | null;
  readonly prompt: PromptInput["previous"];
} => {
  const unrelated = { trigger: null, commits: null, note: null, prompt: null };
  if (previous === null) return unrelated;
  const { revision, head_sha: headSha } = previous;
  switch (since._tag) {
    case "descends": {
      const commits = local === null ? since.commits : (local.newCommits ?? []);
      return {
        trigger: "new-commits",
        commits: commits.length,
        note:
          local === null
            ? `${plural(commits.length, "new commit")} since revision ${revision}`
            : `The changes moved on since revision ${revision}${commits.length === 0 ? "" : `, with ${plural(commits.length, "new commit")}`}`,
        prompt: {
          _tag: "descends",
          revision,
          headSha,
          commits,
          diffFile: files.since,
          guideFile: files.guide,
        },
      };
    }
    case "rewritten":
      return {
        trigger: "rewritten",
        commits: null,
        note:
          local === null
            ? `The history was rewritten since revision ${revision}, so the guide is written fresh`
            : `The base moved since revision ${revision}, so the guide is written fresh`,
        prompt: { _tag: "rewritten", revision, headSha },
      };
    case "same":
    case "none":
      return unrelated;
  }
};

/** The diff since the last revision as the agent reads it: reviewed files only. */
const sinceDiff = (snapshot: DiffSnapshot) =>
  snapshot.files.length === 0
    ? "No reviewed file changed since the last revision: these commits only touched files the reviewer's ignore rules skip.\n"
    : snapshot.files
        .map((file) =>
          file.patch._tag === "text"
            ? file.patch.patch
            : `diff --git a/${file.previousPath ?? file.path} b/${file.path}\n(${file.patch._tag === "binary" ? "binary file" : `too large to show: ${file.patch.lines} changed lines`})\n`,
        )
        .join("");

/** An attempt's run: its launch, the run itself, a failure, an unchanged run, a new revision, and a review's end. */
export const makeAttemptRun = (
  {
    sql,
    fs,
    path,
    repo,
    agents,
    tokens,
    scope,
    diffsDir,
    slots,
    running,
    phases,
    notices,
    readContexts,
    rejected,
    now,
    publish,
    findStored,
    findReviewById,
    appendActivity,
    setPhase,
    setStatus,
    batchOf,
    settleBatch,
  }: ReviewStore,
  { previousOf, pullRequestPlan, localPlan }: ReturnType<typeof makeAttemptPlans>,
  { storedGuide, runTurn }: ReturnType<typeof makeAttemptTurn>,
) => {
  const failAttempt = (review: StoredReview, attemptId: AttemptId, failure: AttemptFailure) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* setStatus(
            review.id,
            attemptId,
            { _tag: "failed", reason: failure.reason, message: failure.message, attemptId },
            null,
          );
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = ${failure.message}
            WHERE id = ${attemptId} AND finished_at IS NULL`;
        }),
      );
      yield* tokens.revokeAttempt(attemptId);
      // The message can be an agent's own words, so it stays in the activity and out of the log.
      yield* Effect.logWarning("Attempt failed").pipe(
        Effect.annotateLogs({ attemptId, reason: failure.reason }),
      );
      yield* appendActivity(review.key, review.id, attemptId, "error", failure.message);
    });

  /** Commits the attempt's stored guide as the next revision, once its process has exited. */
  const commitRevision = (
    review: StoredReview,
    attemptId: AttemptId,
    revision: number,
    headSha: string,
    baseRef: string,
    notice: { readonly title: string; readonly notify: boolean },
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const committed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const moved = yield* sql`
            UPDATE reviews SET status = ${encodeStatus(watchingAt(headSha, baseRef, at))},
              current_attempt_id = NULL, latest_revision = ${revision}, updated_at = ${at}
            WHERE id = ${review.id} AND current_attempt_id = ${attemptId} RETURNING id`;
          if (moved.length === 0) {
            yield* sql`
              UPDATE review_attempts SET finished_at = ${at}, outcome = 'superseded'
              WHERE id = ${attemptId} AND finished_at IS NULL`;
            return false;
          }
          yield* sql`
            INSERT INTO review_revisions (review_id, revision, attempt_id, head_sha, guide, created_at)
            SELECT review_id, revision, id, ${headSha}, guide, ${at} FROM review_attempts WHERE id = ${attemptId}
            ON CONFLICT (attempt_id) DO NOTHING`;
          yield* sql`UPDATE review_attempts SET finished_at = ${at}, outcome = 'accepted' WHERE id = ${attemptId}`;
          return true;
        }),
      );
      if (!committed) return;
      yield* appendActivity(
        review.key,
        review.id,
        attemptId,
        "note",
        `Guide revision ${revision} is ready`,
      );
      // A stack's guides are announced together once the last one finishes.
      if (!notice.notify || (yield* batchOf(attemptId)) !== null) return;
      const counted = yield* sql`
        SELECT json_array_length(guide, '$.chapters') AS count FROM review_revisions
        WHERE attempt_id = ${attemptId}`.pipe(Effect.flatMap(decodeCount));
      const ready: ReadyNotice = {
        _tag: "ready",
        review,
        title: notice.title,
        revision,
        chapters: counted[0]?.count ?? 0,
      };
      yield* PubSub.publish(notices, ready);
    });

  /** A watcher attempt that found the previous revision's head: nothing to update, back to watching. */
  const settleUnchanged = (
    review: StoredReview,
    attemptId: AttemptId,
    previous: typeof PreviousRow.Type,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const settled = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            UPDATE reviews SET status = ${encodeStatus(watchingAt(previous.head_sha, previous.base_ref, at))},
              current_attempt_id = NULL, updated_at = ${at}
            WHERE id = ${review.id} AND current_attempt_id = ${attemptId} RETURNING id`;
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'superseded'
            WHERE id = ${attemptId} AND finished_at IS NULL`;
          return rows.length > 0;
        }),
      );
      if (settled)
        yield* appendActivity(
          review.key,
          review.id,
          attemptId,
          "note",
          `Nothing new since revision ${previous.revision}`,
        );
    });

  const runAttempt = (
    review: StoredReview,
    attemptId: AttemptId,
    revision: number,
    trigger: AttemptTrigger,
  ) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => rejected.delete(attemptId)));
      yield* setPhase(review.key, review.id, attemptId, "preparing-code");
      const provider = yield* agents.get(review.instance);
      if (provider === null)
        return yield* fail(
          "agent-auth",
          "This guide's agent is turned off or was removed. Pick another agent and retry.",
        );
      const state = yield* provider.check;
      if (state._tag === "unavailable") {
        yield* agents.invalidate;
        return yield* fail("agent-auth", state.message);
      }

      const previous = yield* previousOf(review.id);
      const front: PullRequestFront =
        review.kind === "pull-request"
          ? yield* pullRequestPlan(review, attemptId, previous)
          : { _tag: "plan", plan: yield* localPlan(review, attemptId, previous) };
      if (front._tag === "ended")
        return yield* end(front.key, front.state).pipe(
          Effect.catchTag("ReviewStateError", () => Effect.void),
        );
      const { plan } = front;
      const { code: ready, settings, retargeted } = plan;
      const since = ready.since;
      if (
        since._tag === "same" &&
        trigger === "new-commits" &&
        previous !== null &&
        retargeted === null
      )
        return yield* settleUnchanged(review, attemptId, previous);
      const { reviewed, skipped } = projectSnapshot(settings.ignore, ready.snapshot);
      const signals = riskSignals({ reviewed, skipped, sensitive: settings.sensitive });
      const config: AttemptConfig = {
        ...settings,
        repository: plan.repository,
        skipped,
        signals,
        // A local review is its author's own too, but it gets no pre-flight yet.
        preflight:
          plan.prompt._tag === "pull-request" && plan.prompt.authored
            ? { description: plan.prompt.target.body.trim() }
            : null,
        manualCheck: true,
      };
      // A guide written under other settings is written again from scratch, not updated on top.
      const changedSince =
        previous !== null && previous.config_hash !== settings.hash ? previous : null;
      const diffDir = path.join(diffsDir, attemptId);
      // The guide's commands keep their temporary files here, removed with the diffs.
      const tmpDir = turnTmpDir(path, attemptId);
      const files = {
        diff: path.join(diffDir, review.kind === "local" ? "changes.diff" : "pull-request.diff"),
        since: path.join(diffDir, `since-revision-${previous?.revision ?? 0}.diff`),
        guide: path.join(diffDir, `guide-revision-${previous?.revision ?? 0}.json`),
      };
      const related = following(
        previous,
        since,
        files,
        plan.prompt._tag === "local" ? plan.prompt.capture : null,
      );
      const follows =
        retargeted !== null
          ? {
              trigger: "retargeted" as const,
              commits: null,
              note: `The pull request now merges into ${plan.baseRef} instead of ${retargeted.from}, so the guide is written fresh`,
              prompt: { _tag: "retargeted" as const, ...retargeted, to: plan.baseRef },
            }
          : changedSince !== null
            ? {
                ...related,
                note: `Your guide settings changed since revision ${changedSince.revision}, so the guide is written fresh`,
                prompt: null,
              }
            : related;
      const changedLines = reviewed.files.reduce(
        (total, file) => total + file.additions + file.deletions,
        0,
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE review_attempts SET head_sha = ${ready.headSha}, base_sha = ${ready.baseSha},
              base_ref = ${plan.baseRef},
              merge_base_sha = ${ready.mergeBaseSha}, snapshot = ${encodeSnapshot(ready.snapshot)},
              config = ${encodeConfig(config)}, config_hash = ${settings.hash},
              trigger = ${follows.trigger ?? trigger}, commits = ${follows.commits},
              changed_lines = ${changedLines}
            WHERE id = ${attemptId} AND finished_at IS NULL`;
          yield* Effect.forEach(
            reviewed.files,
            (file, position) => sql`
              INSERT INTO review_attempt_files (attempt_id, position, path, previous_path, status, additions, deletions)
              VALUES (${attemptId}, ${position}, ${file.path}, ${file.previousPath}, ${file.status},
                ${file.additions}, ${file.deletions})
              ON CONFLICT (attempt_id, path) DO NOTHING`,
            { discard: true },
          );
        }),
      );
      yield* Effect.logInfo("Froze the attempt's guide settings").pipe(
        Effect.annotateLogs({
          hash: settings.hash,
          rules: settings.ignore.filter((rule) => rule.active).length,
          lookClosely: settings.sensitive.filter((rule) => rule.active).length,
          signals: signals.map((signal) => signal._tag).join(","),
          skipped: skipped.length,
          focusAreas: settings.focusAreas.flatMap((area) => area.handle ?? []).join(","),
          guidance: settings.guidance
            .filter((block) => block.replacedBy === null)
            .map((block) => block.scope)
            .join(","),
          danglingOverrides: settings.dangling.length,
        }),
      );
      if (changedSince !== null)
        yield* Effect.logInfo(
          "Guide settings changed since the last revision; starting a fresh session",
        ).pipe(
          Effect.annotateLogs({
            revision: changedSince.revision,
            previousHash: changedSince.config_hash,
            hash: settings.hash,
          }),
        );
      if (reviewed.files.length === 0 && skipped.length > 0)
        return yield* fail("settings", everythingSkippedMessage(skipped));
      const checkedOut = `Checked out ${short(ready.headSha)}: ${plural(ready.snapshot.files.length, "changed file")}${skipped.length === 0 ? "" : `, ${skipped.length} skipped by your ignore rules`}`;
      yield* appendActivity(
        review.key,
        review.id,
        attemptId,
        "note",
        follows.note === null ? checkedOut : `${checkedOut}. ${follows.note}`,
      );
      if (
        !(yield* setStatus(
          review.id,
          attemptId,
          { _tag: "writing", attemptId, revision },
          attemptId,
        ))
      )
        return;
      yield* publish(review.key);

      const diff = numberedDiff(reviewed);
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* fs.makeDirectory(diffDir, { recursive: true });
          yield* fs.remove(tmpDir, { recursive: true, force: true });
          yield* fs.makeDirectory(tmpDir, { mode: 0o700 });
          yield* fs.writeFileString(files.diff, diff.text);
          yield* Effect.forEach(plan.files, (file) => fs.writeFileString(file.path, file.text), {
            discard: true,
          });
          readContexts.set(attemptId, {
            worktree: ready.worktree,
            diffFile: files.diff,
            sections: diff.sections,
            paths: new Set(reviewed.files.map((file) => file.path)),
            covered: [],
          });
          if (follows.prompt?._tag !== "descends" || since._tag !== "descends" || previous === null)
            return;
          yield* fs.writeFileString(
            files.since,
            sinceDiff(projectSnapshot(settings.ignore, since.snapshot).reviewed),
          );
          yield* fs.writeFileString(
            files.guide,
            encodeReadableGuide({
              ...previous.guide,
              chapters: previous.guide.chapters.filter(
                (chapter) => chapter.id !== SKIPPED_CHAPTER_ID,
              ),
            }),
          );
        }),
        () =>
          Effect.sync(() => readContexts.delete(attemptId)).pipe(
            Effect.andThen(fs.remove(diffDir, { recursive: true, force: true })),
            Effect.andThen(fs.remove(tmpDir, { recursive: true, force: true })),
            Effect.ignore,
          ),
      );
      const current = yield* findReviewById(review.id);
      const catalog = yield* agents.catalog();
      const model = findAgentModel(catalog, review.instance, current?.model ?? null);
      // Every setting the model takes goes in explicitly, so a resumed session
      // doesn't keep a choice from an earlier attempt.
      const options = explicitModelOptions(model, current?.modelOptions ?? []);
      yield* sql`
        UPDATE review_attempts SET model_options = ${encodeOptions(options)}
        WHERE id = ${attemptId} AND finished_at IS NULL`;
      const prompt = buildPrompt({
        subject: plan.prompt,
        mergeBaseSha: ready.mergeBaseSha,
        snapshot: reviewed,
        diffFile: files.diff,
        settings: {
          skipped: skipped.length,
          guidance: settings.guidance.filter((block) => block.replacedBy === null),
          focusAreas: settings.focusAreas.filter((area) => area.active),
        },
        signals,
        previous: follows.prompt,
        streamsGuideInput: provider.streamsGuideInput,
      });
      yield* Effect.logInfo("Composed the prompt").pipe(
        Effect.annotateLogs({ sections: prompt.sections.join(" ") }),
      );
      let resume = changedSince === null ? (current?.sessionId ?? null) : null;
      if (resume !== null && !(yield* provider.hasSession(resume, ready.worktree))) {
        resume = null;
        yield* appendActivity(
          review.key,
          review.id,
          attemptId,
          "note",
          `${provider.label} no longer has this review's earlier conversation, so this attempt starts a new one`,
        );
      }
      yield* setPhase(review.key, review.id, attemptId, "reading-change");
      const turn = {
        cwd: ready.worktree,
        checkout: ready.checkout,
        diffDir,
        tmpDir,
        model: current?.model ?? null,
        options,
      };
      const first = yield* runTurn(provider, review, attemptId, {
        ...turn,
        prompt: prompt.text,
        resume,
      });
      if (!(yield* storedGuide(attemptId))) {
        if (first.finished?.outcome !== "completed" || first.sessionId === null)
          return yield* fail(
            "agent",
            first.finished?.message ?? `${provider.label} stopped before submitting a guide.`,
          );
        yield* appendActivity(
          review.key,
          review.id,
          attemptId,
          "note",
          "The agent ended without a guide that passes prkit's checks. Asking once more",
        );
        yield* runTurn(provider, review, attemptId, {
          ...turn,
          prompt: NUDGE_PROMPT,
          resume: first.sessionId,
        });
        if (!(yield* storedGuide(attemptId)))
          return yield* fail(
            "no-guide",
            `${provider.label} finished twice without a guide that passes prkit's checks. Retry to start over.`,
          );
      }
      yield* repo
        .keepRevision(plan.cache, review.id, revision, ready.headSha)
        .pipe(Effect.catchTag("RepoError", (error) => fail(error.reason, error.message)));
      yield* commitRevision(review, attemptId, revision, ready.headSha, plan.baseRef, {
        title: plan.title,
        notify: trigger === "first" || trigger === "retry",
      });
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(
            new AttemptFailure({
              reason: "agent",
              message: "prkit couldn't save the review.",
            }),
          ),
        SchemaError: () =>
          Effect.fail(
            new AttemptFailure({
              reason: "agent",
              message: "prkit read a damaged review record.",
            }),
          ),
        PlatformError: () =>
          Effect.fail(
            new AttemptFailure({
              reason: "repository",
              message:
                "prkit couldn't write the review's files. Check the disk has space, then retry.",
            }),
          ),
      }),
    );

  /** Runs the attempt in the service's scope; interrupting the fiber stops the agent process. */
  const launch = (
    review: StoredReview,
    attemptId: AttemptId,
    revision: number,
    trigger: AttemptTrigger,
  ) =>
    Effect.gen(function* () {
      const registered = yield* Deferred.make<void>();
      const body = runAttempt(review, attemptId, revision, trigger).pipe(
        Effect.catchTag("AttemptFailure", (failure) => failAttempt(review, attemptId, failure)),
        Effect.catchTags({
          SqlError: (error) => Effect.logError("Couldn't record the attempt's failure", error),
          SchemaError: (error) => Effect.logError("Couldn't record the attempt's failure", error),
        }),
        Effect.tapDefect((defect) =>
          Effect.logError("Attempt crashed", defect).pipe(
            Effect.andThen(
              failAttempt(
                review,
                attemptId,
                new AttemptFailure({
                  reason: "agent",
                  message: "prkit hit an internal error.",
                }),
              ),
            ),
            Effect.ignore,
          ),
        ),
        Effect.andThen(publish(review.key)),
        Effect.annotateLogs({ reviewId: review.id, attemptId }),
      );
      const fiber = yield* Deferred.await(registered).pipe(
        Effect.andThen(
          slots
            .withPermitsIfAvailable(1)(body)
            .pipe(
              Effect.flatMap((ran) =>
                Option.isSome(ran)
                  ? Effect.void
                  : setPhase(review.key, review.id, attemptId, "queued").pipe(
                      Effect.ignore,
                      Effect.andThen(slots.withPermits(1)(body)),
                    ),
              ),
            ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running.delete(attemptId);
            phases.delete(attemptId);
          }).pipe(Effect.andThen(settleBatch(attemptId))),
        ),
        Effect.forkIn(scope),
      );
      running.set(attemptId, fiber);
      yield* Deferred.succeed(registered, undefined);
    });

  /**
   * Ends the review: done(reason), its running attempt stopped and its process gone,
   * tokens revoked, checkout removed. Revisions stay. The Stop command and the
   * watcher (merged, closed) both come through here.
   */
  const end = (key: ReviewKey, reason: DoneReason) =>
    Effect.gen(function* () {
      for (let tries = 0; tries < 3; tries++) {
        const review = yield* findStored(key);
        const outcome = decide("stop", review?.status ?? null);
        if (outcome._tag === "reject")
          return yield* new ReviewStateError({ key, message: outcome.message });
        if (outcome._tag === "noop" || review === null) return;
        const attemptId =
          review.status._tag === "preparing" || review.status._tag === "writing"
            ? review.status.attemptId
            : null;
        if (!(yield* setStatus(review.id, attemptId, { _tag: "done", reason }, null))) continue;
        if (attemptId !== null) {
          const at = yield* now;
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = ${ENDED[reason]}
            WHERE id = ${attemptId} AND finished_at IS NULL`;
          const fiber = running.get(attemptId);
          // Waits for the turn's scope to close, which ends the agent's process group. An
          // attempt that finds its PR closed ends the review from its own fiber.
          if (fiber !== undefined && fiber !== (yield* Effect.fiber)) yield* Fiber.interrupt(fiber);
          yield* tokens.revokeAttempt(attemptId);
          yield* appendActivity(key, review.id, attemptId, "note", ENDED[reason]);
        }
        yield* repo
          .removeWorktree(review.id, cacheOf(review))
          .pipe(Effect.catchTag("RepoError", (error) => Effect.logWarning(error.message)));
        yield* Effect.logInfo("Review ended").pipe(
          Effect.annotateLogs({ reviewId: review.id, reason, attemptId: attemptId ?? "" }),
        );
        yield* publish(key);
        return;
      }
    });

  return { launch, end };
};
