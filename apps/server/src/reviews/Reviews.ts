import {
  type AccountId,
  type AgentSelection,
  AttemptConfig,
  AttemptId,
  AttemptTrigger,
  DiffSnapshot,
  type DoneReason,
  everythingSkippedMessage,
  effectiveSelection,
  explicitModelOptions,
  findAgentEntry,
  findAgentModel,
  type GuidanceEdit,
  type GuideRepository,
  isAccountLogin,
  isLocalReviewKey,
  LocalReviewKey,
  LocalSource,
  NormalizedGuide,
  projectSnapshot,
  PullRequestKey,
  type PullRequestRef,
  pullRequestKey,
  type PullRequestStack,
  type ResolvedGuideConfig,
  type Review,
  type ReviewCore,
  ReviewError,
  ReviewId,
  ReviewKey,
  ReviewStateError,
  ReviewStatus,
  type ReviewWatchEvent,
  refFromKey,
  riskSignals,
  SKIPPED_CHAPTER_ID,
  selectionProblem,
  type StackGuidesResult,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import { ChildProcessSpawner } from "effect/process";

import { type AgentProvider, GUIDE_TOOLS } from "../agents/AgentProvider.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import type { FileRead } from "../agents/commandReads.ts";
import { processStartTime, reapAgentGroup } from "../agents/agentProcess.ts";
import { GitHubApi, GitHubPriority } from "../github/GitHubApi.ts";
import { decodeEach, decodeReadable } from "../persistence/damagedRows.ts";
import { LocalCapture } from "../repo/localCapture.ts";
import { type CacheRef, type Checkout, type Prepared, type Since } from "../repo/RepoCache.ts";
import { ContextPriority, unattended } from "./ContextPriority.ts";
import { contextJson, contextNotes } from "./contextFile.ts";
import { makeGuideStream } from "./guideStream.ts";
import { decide, type Observation, observe, STARTABLE } from "./lifecycle.ts";
import { makeLocalReviews } from "./localReviews.ts";
import {
  buildPrompt,
  NUDGE_PROMPT,
  numberedDiff,
  type PromptInput,
  type PromptSubject,
} from "./prompt.ts";
import { reviewTarget } from "./reviewTarget.ts";
import { stopUnreadableReviews } from "./unreadableReviews.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import {
  AttemptFailure,
  cacheOf,
  encodeOptions,
  encodeStatus,
  type LocalStoredReview,
  makeReviewStore,
  type NewSubject,
  type PendingRead,
  plural,
  type PullRequestReview,
  PullRequestRow,
  type ReadContext,
  type ReadyNotice,
  ReviewRow,
  type StoredAgent,
  type StoredReview,
  toPullRequestReview,
  toStored,
} from "./reviewStore.ts";
import { makeGuideTools } from "./guideTools.ts";
import { makeReviewReads } from "./reviewReads.ts";

export {
  AttemptRow,
  type Change,
  type LocalStoredReview,
  type NewSubject,
  type ReadyNotice,
  ReviewRow,
  type StoredAgent,
  type StoredReview,
} from "./reviewStore.ts";
export {
  SubmitGuideReceipt,
  SubmitGuideRejected,
  ToolReceipt,
  ToolRejected,
} from "./guideTools.ts";
export { type RevisionContext } from "./reviewReads.ts";

const fail = (reason: AttemptFailure["reason"], message: string) =>
  Effect.fail(new AttemptFailure({ reason, message }));

const PreviousRow = Schema.Struct({
  revision: Schema.Int,
  head_sha: Schema.String,
  /** Null for revisions written before prkit kept it. */
  base_ref: Schema.NullOr(Schema.String),
  guide: Schema.fromJsonString(NormalizedGuide),
  config_hash: Schema.String,
});
const IdRow = Schema.Struct({ id: Schema.String });
const StaleRow = Schema.Struct({
  id: AttemptId,
  review_id: ReviewId,
  agent_pid: Schema.NullOr(Schema.Int),
  agent_started: Schema.NullOr(Schema.String),
});

/** Lists read every row they can and leave a damaged one out (logged), so it fails alone. */
const readableReviews = decodeReadable("reviews", ReviewRow);
const decodeEachReview = decodeEach("reviews", ReviewRow);
const readablePullRequests = decodeReadable("reviews", PullRequestRow);
const decodePrevious = Schema.decodeUnknownEffect(Schema.Array(PreviousRow));
const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })));
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow));
const decodeStale = Schema.decodeUnknownEffect(Schema.Array(StaleRow));
const decodeStarted = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ latest_revision: Schema.NullOr(Schema.Int) })),
);
const decodeLocalKeys = decodeEach("reviews", Schema.Struct({ pr_key: LocalReviewKey }));
/** The previous guide as the agent reads it: indented, so no line is too long to read. */
const encodeReadableGuide = Schema.encodeSync(
  Schema.fromJsonString(NormalizedGuide.mapFields(Struct.omit(["signals"])), { space: 2 }),
);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(DiffSnapshot));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AttemptConfig));
const encodeLocal = Schema.encodeSync(Schema.fromJsonString(LocalSource));

/** What the watcher reads and applies its reads to: pull requests only. */
export type WatchedReview = PullRequestReview;

const storedAgentOf = (review: ReviewCore): StoredAgent => ({
  instance: review.instance,
  provider: review.provider,
  model: review.model,
  options: review.modelOptions,
});
/** Who started a review: the user, or auto mode for a review request. */
export type Origin = "user" | "auto" | "outside";

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

/** What an attempt's subject hands the rest of the attempt: the code, settings and prompt. */
interface AttemptPlan {
  readonly code: Prepared;
  /** Stored on the attempt and on `watching`. */
  readonly baseRef: string;
  /** Read once: edits saved from here on apply to the next attempt. */
  readonly settings: ResolvedGuideConfig;
  readonly repository: GuideRepository | null;
  /** The base branch changed since the last revision, so the guide is written fresh. */
  readonly retargeted: { readonly revision: number; readonly from: string } | null;
  readonly prompt: PromptSubject;
  /** What the ready notice calls the guide. */
  readonly title: string;
  /** Where the accepted revision's head is kept. */
  readonly cache: CacheRef;
  /** Files the agent reads next to the diff, written with it. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}
/** A pull request's front: the attempt's plan, or the PR was merged or closed. */
type PullRequestFront =
  | { readonly _tag: "plan"; readonly plan: AttemptPlan }
  | { readonly _tag: "ended"; readonly key: PullRequestKey; readonly state: "merged" | "closed" };

/** Adds a range to sorted, merged ranges. */
const mergeRange = (
  ranges: ReadonlyArray<readonly [number, number]>,
  next: readonly [number, number],
) =>
  [...ranges, next]
    .toSorted((left, right) => left[0] - right[0])
    .reduce<Array<readonly [number, number]>>((merged, range) => {
      const last = merged.at(-1);
      if (last !== undefined && range[0] <= last[1] + 1)
        merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
      else merged.push(range);
      return merged;
    }, []);

export class Reviews extends Context.Service<Reviews, Effect.Success<typeof make>>()(
  "@prkit/server/reviews/Reviews",
) {}

export const make = Effect.gen(function* () {
  const store = yield* makeReviewStore;
  const {
    sql,
    fs,
    path,
    repo,
    agents,
    tokens,
    accounts,
    api,
    guideSettings,
    guideConfig,
    pullRequests,
    spawner,
    scope,
    mcpUrl,
    instructions,
    diffsDir,
    runId,
    slots,
    running,
    phases,
    changes,
    notices,
    reading,
    growing,
    readContexts,
    rejected,
    now,
    newId,
    publish,
    findReview,
    findLocal,
    findSubject,
    locals,
    findStored,
    findReviewById,
    summaryOf,
    progressOf,
    snapshotOf,
    activityOf,
    captureOf,
    appendActivity,
    setPhase,
    setStatus,
    insertAttempt,
    noteStartedBy,
    batchOf,
    settleBatch,
    dbFailures,
  } = store;
  const {
    reportProgress,
    noteFile,
    submitDraft,
    streamDraft,
    draftChapters,
    submitGuide,
    reviseGuide,
  } = makeGuideTools(store);
  const { guide, revisionContext, draft, diff, texts, typicalDuration, index, feed } =
    makeReviewReads(store);

  /**
   * What a tool call's reads point at: checkout files that are in the diff, and the
   * files whose part of the numbered diff it prints, with the diff coverage it adds.
   */
  const readTargets = (context: ReadContext, reads: ReadonlyArray<FileRead>): PendingRead => {
    const direct = new Set<string>();
    const sections = new Set<string>();
    const ranges: Array<readonly [number, number]> = [];
    // The diff file sits in a directory named after the attempt, under either spelling of a symlinked home.
    const diffSuffix = `${path.sep}${path.basename(path.dirname(context.diffFile))}${path.sep}${path.basename(context.diffFile)}`;
    for (const read of reads) {
      const absolute = path.resolve(context.worktree, read.path);
      if (absolute.endsWith(diffSuffix)) {
        const total = context.sections.at(-1)?.end ?? 0;
        const range: readonly [number, number] =
          read.lines._tag === "all"
            ? [1, total]
            : read.lines._tag === "range"
              ? [read.lines.start, read.lines.end]
              : [Math.max(1, total - read.lines.count + 1), total];
        ranges.push(range);
        for (const section of context.sections)
          if (section.start <= range[1] && section.end >= range[0]) sections.add(section.path);
        continue;
      }
      const relativePath = path.relative(context.worktree, absolute);
      if (context.paths.has(relativePath)) direct.add(relativePath);
    }
    return { direct: [...direct], sections: [...sections], ranges };
  };

  /** Files a returned tool call finished reading; a diff part counts once all its lines were printed. */
  const finishedReads = (context: ReadContext, pending: PendingRead) => {
    context.covered = pending.ranges.reduce(mergeRange, context.covered);
    return [
      ...pending.direct,
      ...pending.sections.filter((file) => {
        const section = context.sections.find((entry) => entry.path === file);
        // The trailing blank line after a file's part may be left out of a range.
        return (
          section !== undefined &&
          context.covered.some(([low, high]) => low <= section.start && high >= section.end - 1)
        );
      }),
    ];
  };

  /** Marks files read once the tool call that printed them returned. */
  const markRead = (attemptId: AttemptId, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (paths.length === 0) return;
      const at = yield* now;
      yield* sql`
        UPDATE review_attempt_files SET read_at = ${at}
        WHERE attempt_id = ${attemptId} AND read_at IS NULL AND path IN ${sql.in(paths)}`;
    });

  /** The layers of the PR's stack for the prompt. Without them the guide is still written. */
  const stackFor = (review: Review, attemptId: AttemptId, stack: number) =>
    pullRequests
      .readStack(review.key, review.accountId, stack)
      .pipe(
        Effect.catchTag("PullRequestReadError", (error) =>
          appendActivity(
            review.key,
            review.id,
            attemptId,
            "note",
            `Couldn't read the stack this pull request is in, so the guide is written without it. ${error.message}`,
          ).pipe(Effect.as<PullRequestStack | null>(null)),
        ),
      );

  /**
   * What GitHub says about the PR besides its diff, read once for the head the attempt fetched:
   * the prompt's view of it and the file the agent reads. The activity log says what it holds.
   */
  const contextFor = (
    review: PullRequestReview,
    attemptId: AttemptId,
    ref: PullRequestRef,
    headSha: string,
  ) =>
    Effect.gen(function* () {
      const read = yield* pullRequests
        .context(review.key, review.accountId, headSha)
        .pipe(Effect.provideService(GitHubPriority, yield* ContextPriority));
      for (const note of contextNotes(read))
        yield* appendActivity(review.key, review.id, attemptId, "note", note);
      return { read, json: contextJson(read, { ref, headSha }) };
    });

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
      yield* Effect.logWarning("Attempt failed").pipe(
        Effect.annotateLogs({ reason: failure.reason, message: failure.message }),
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

  const storedGuide = (attemptId: AttemptId) =>
    sql`SELECT id FROM review_attempts WHERE id = ${attemptId} AND guide IS NOT NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  /** One agent turn with a fresh bearer token, revoked when the turn's process is gone. */
  const runTurn = (
    provider: AgentProvider,
    review: StoredReview,
    attemptId: AttemptId,
    input: {
      readonly cwd: string;
      readonly checkout: Checkout;
      readonly diffDir: string;
      readonly tmpDir: string;
      readonly prompt: string;
      readonly resume: string | null;
      readonly model: string | null;
      readonly options: AgentSelection["options"];
    },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const token = yield* tokens.issue({ _tag: "guide", attemptId, reviewId: review.id });
        const inFlight = new Map<string, PendingRead>();
        reading.set(attemptId, inFlight);
        yield* Effect.addFinalizer(() => Effect.sync(() => reading.delete(attemptId)));
        /** Each `submit_guide` call being written, by call id; `fresh` if it started on a draft without chapters. */
        const guideCalls = new Map<
          string,
          { readonly stream: ReturnType<typeof makeGuideStream>; readonly fresh: boolean }
        >();
        yield* Effect.addFinalizer(() => Effect.sync(() => growing.delete(attemptId)));
        const result: {
          sessionId: string | null;
          finished: { readonly outcome: string; readonly message: string | null } | null;
        } = { sessionId: input.resume, finished: null };
        yield* provider
          .runTurn({
            // A guide turn can't write the checkout, so what it leaves can't reach prkit's git.
            turn: { id: attemptId, ended: () => Effect.void },
            cwd: input.cwd,
            checkout: input.checkout,
            readableDirs: [input.diffDir],
            instructions,
            prompt: input.prompt,
            resumeSessionId: input.resume,
            model: input.model,
            options: input.options,
            mcp: { url: mcpUrl, bearerToken: Redacted.value(token) },
            env: repo.isolatedGitEnv,
            access: { _tag: "read-only", tmpDir: input.tmpDir },
            tools: GUIDE_TOOLS,
          })
          .pipe(
            // Once the agent has its accepted guide back, the turn is over: its closing reply adds nothing.
            Stream.takeUntilEffect((event) =>
              event._tag === "tool-done" && event.ok
                ? storedGuide(attemptId)
                : Effect.succeed(false),
            ),
            Stream.runForEach((event) => {
              switch (event._tag) {
                case "process":
                  return processStartTime(event.pid).pipe(
                    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                    Effect.flatMap(
                      (started) => sql`
                      UPDATE review_attempts SET agent_pid = ${event.pid}, agent_started = ${started}
                      WHERE id = ${attemptId}`,
                    ),
                    Effect.asVoid,
                  );
                case "session":
                  result.sessionId = event.sessionId;
                  // Saved the moment it is known, so a crash mid-turn still leaves it resumable.
                  return sql`UPDATE reviews SET session_id = ${event.sessionId}
                    WHERE id = ${review.id} AND current_attempt_id = ${attemptId}`.pipe(
                    Effect.asVoid,
                  );
                case "tool": {
                  const context = readContexts.get(attemptId);
                  const pending = context === undefined ? null : readTargets(context, event.reads);
                  if (pending !== null && pending.direct.length + pending.sections.length > 0)
                    inFlight.set(event.id, pending);
                  return appendActivity(
                    review.key,
                    review.id,
                    attemptId,
                    "tool",
                    event.label,
                    event.detail,
                  );
                }
                case "tool-done": {
                  const pending = inFlight.get(event.id);
                  const context = readContexts.get(attemptId);
                  if (pending === undefined || context === undefined) return Effect.void;
                  inFlight.delete(event.id);
                  return (
                    event.ok ? markRead(attemptId, finishedReads(context, pending)) : Effect.void
                  ).pipe(Effect.andThen(publish(review.key)));
                }
                case "composing-guide":
                  return setPhase(review.key, review.id, attemptId, "writing-guide");
                case "guide-input":
                  return Effect.gen(function* () {
                    const call =
                      guideCalls.get(event.id) ??
                      (yield* draftChapters(attemptId).pipe(
                        Effect.map((count) => ({ stream: makeGuideStream(), fresh: count === 0 })),
                        Effect.tap((created) =>
                          Effect.sync(() => guideCalls.set(event.id, created)),
                        ),
                      ));
                    const pieces = call.stream.feed(event.json);
                    const wasGrowing = growing.has(attemptId);
                    if (call.fresh && call.stream.chaptersOpen()) growing.add(attemptId);
                    else growing.delete(attemptId);
                    yield* Effect.forEach(pieces, (piece) => streamDraft(attemptId, piece), {
                      discard: true,
                    });
                    if (pieces.length === 0 && wasGrowing !== growing.has(attemptId))
                      yield* publish(review.key);
                  });
                case "finished":
                  result.finished = { outcome: event.outcome, message: event.message };
                  return Effect.logInfo("Agent turn finished").pipe(
                    Effect.annotateLogs({ outcome: event.outcome, message: event.message ?? "" }),
                  );
                case "mcp-ready":
                case "text":
                  return Effect.void;
              }
            }),
            Effect.catchTag("AgentError", (error) =>
              (error.reason === "auth" ? agents.invalidate : Effect.void).pipe(
                Effect.andThen(
                  Effect.fail(
                    new AttemptFailure({
                      reason: error.reason === "auth" ? "agent-auth" : "agent",
                      message: error.message,
                    }),
                  ),
                ),
              ),
            ),
          );
        return result;
      }),
    );

  /** The last accepted revision, for an attempt that may update its guide. */
  const previousOf = (reviewId: ReviewId) =>
    sql`
      SELECT r.revision, r.head_sha, a.base_ref, r.guide, a.config_hash FROM review_revisions r
      JOIN review_attempts a ON a.id = r.attempt_id
      WHERE r.review_id = ${reviewId} ORDER BY r.revision DESC LIMIT 1`.pipe(
      Effect.flatMap(decodePrevious),
      Effect.map((rows) => rows[0] ?? null),
    );

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

  /** A pull request's code, settings and prompt, read through its account, or that it was merged or closed. */
  const pullRequestPlan = (
    review: PullRequestReview,
    attemptId: AttemptId,
    previous: typeof PreviousRow.Type | null,
  ) =>
    Effect.gen(function* () {
      const ref = refFromKey(review.key);
      if (ref === null) return yield* fail("repository", "This pull request's key can't be read.");
      // Make sure accounts are discovered before asking for this review's token.
      yield* accounts
        .list()
        .pipe(Effect.catchTag("AccountsError", (error) => fail("account", error.message)));
      const target = yield* reviewTarget(ref, review.accountId).pipe(
        Effect.provideService(GitHubApi, api),
        Effect.catchTag("GitHubRequestError", (error) =>
          fail(error.reason === "unauthorized" ? "account" : "github", error.message),
        ),
      );
      if (target.state !== "open")
        return { _tag: "ended", key: review.key, state: target.state } satisfies PullRequestFront;
      // The settings this attempt runs with, read once: edits saved from here on apply to the next attempt.
      yield* guideConfig.remember(target.repository);
      const settings = yield* guideConfig.resolve(target.repository.id, review.key);
      const stack =
        target.stack === null ? null : yield* stackFor(review, attemptId, target.stack.number);
      // The layer below merged and the PR now targets the trunk: its diff is measured
      // against another base, so the guide is written fresh instead of updated on top.
      const retargeted =
        previous !== null && previous.base_ref !== null && previous.base_ref !== target.baseRef
          ? { revision: previous.revision, from: previous.base_ref }
          : null;
      const code = yield* repo
        .prepare({
          reviewId: review.id,
          ref,
          accountId: review.accountId,
          baseRef: target.baseRef,
          previousHead: previous?.head_sha ?? null,
        })
        .pipe(Effect.catchTag("RepoError", (error) => fail(error.reason, error.message)));
      const context = yield* contextFor(review, attemptId, ref, code.headSha);
      const contextFile = path.join(diffsDir, attemptId, "pull-request-context.json");
      const plan: AttemptPlan = {
        code,
        baseRef: target.baseRef,
        settings,
        repository: target.repository,
        retargeted,
        prompt: {
          _tag: "pull-request",
          target: { ...target, headSha: code.headSha },
          stack,
          context: { file: contextFile, read: context.read },
          authored: isAccountLogin(review.accountId, target.author),
        },
        title: target.title,
        cache: { _tag: "pull-request", ref },
        files: [{ path: contextFile, text: context.json }],
      };
      return { _tag: "plan", plan } satisfies PullRequestFront;
    });

  /**
   * Local changes: the snapshot the attempt's run took, checked out from the review's own copy
   * for this attempt only, and Global guide settings, the only scope a local review has.
   */
  const localPlan = (
    review: LocalStoredReview,
    attemptId: AttemptId,
    previous: typeof PreviousRow.Type | null,
  ) =>
    Effect.gen(function* () {
      const capture = yield* captureOf(attemptId);
      if (capture === null)
        return yield* fail("repository", "This run has no snapshot. Run prkit again.");
      const settings = yield* guideConfig.resolveGlobal();
      yield* Effect.addFinalizer(() =>
        repo.removeWorktree(review.id, cacheOf(review)).pipe(Effect.ignore),
      );
      const code = yield* repo.local
        .prepare({
          reviewId: review.id,
          key: review.key,
          capture,
          previousHead: previous?.head_sha ?? null,
        })
        .pipe(Effect.catchTag("RepoError", (error) => fail(error.reason, error.message)));
      const plan: AttemptPlan = {
        code,
        baseRef: capture.baseRef,
        settings,
        repository: null,
        retargeted: null,
        prompt: { _tag: "local", name: review.local.name, capture },
        title: `${review.local.name} · ${capture.branch ?? "detached HEAD"}`,
        cache: { _tag: "local", key: review.key },
        files: [],
      };
      return plan;
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
   * The agent a review runs on now: its own instance while that is on, else its kind's default
   * instance (same model), else the default agent. Nothing ready keeps the review's own, and the
   * attempt then says why it can't run.
   */
  const usableAgent = (agent: StoredAgent) =>
    Effect.gen(function* () {
      const instance = yield* agents.usable(agent.instance, agent.provider);
      if (instance === agent.instance) return agent;
      if (instance !== null) return { ...agent, instance };
      const catalog = yield* agents.catalog();
      const settings = yield* guideSettings.get();
      const chosen = effectiveSelection(catalog, settings.defaultAgent);
      const entry = chosen === null ? undefined : findAgentEntry(catalog, chosen.instance);
      return chosen === null || entry === undefined ? agent : { ...chosen, provider: entry.kind };
    }).pipe(Effect.catchTag("GuideSettingsError", () => Effect.succeed(agent)));

  /**
   * Moves the review from one of `from` to `preparing` with a new attempt and runs it.
   * A new `agent` replaces the review's; a different provider starts a new
   * conversation with it. Uninterruptible once the attempt is committed: it must reach its
   * worker, or nothing settles it until a restart (so is `ensureReview`).
   */
  const startAttempt = (
    review: StoredReview,
    trigger: AttemptTrigger,
    {
      from = STARTABLE,
      agent = storedAgentOf(review),
      batch = null,
      capture = null,
      source = null,
    }: {
      from?: ReadonlyArray<ReviewStatus["_tag"]>;
      agent?: StoredAgent;
      batch?: string | null;
      /** What a local attempt reviews. */
      capture?: LocalCapture | null;
      /** A local review's folder, base and head as this run asked for them. */
      source?: LocalSource | null;
    } = {},
  ) =>
    Effect.gen(function* () {
      // A turned-off or removed instance quietly gives way to its kind's default, else the default agent.
      // Reading the catalog can wait on providers; nothing is committed yet, so it can be interrupted.
      const usable = yield* Effect.interruptible(usableAgent(agent));
      const attemptId = AttemptId.make(yield* newId);
      const at = yield* now;
      // Another conversation group (another kind or config folder) starts a new conversation.
      const sameGroup = yield* Effect.interruptible(agents.sameGroup(usable.instance));
      // The revision number comes from the row the compare-and-set wins, not from the
      // caller's read, which a revision committed since would make stale.
      const revision = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            UPDATE reviews SET status = ${encodeStatus({ _tag: "preparing", attemptId })},
              current_attempt_id = ${attemptId}, updated_at = ${at},
              session_id = CASE WHEN instance_id IN ${sql.in(sameGroup)} THEN session_id ELSE NULL END,
              provider = ${usable.provider}, instance_id = ${usable.instance}, model = ${usable.model},
              model_options = ${encodeOptions(usable.options)}
            WHERE id = ${review.id} AND current_attempt_id IS NULL
              AND json_extract(status, '$._tag') IN ${sql.in(from)}
            RETURNING latest_revision`.pipe(Effect.flatMap(decodeStarted));
          const won = rows[0];
          if (won === undefined) return null;
          if (source !== null)
            yield* sql`UPDATE reviews SET local = ${encodeLocal(source)} WHERE id = ${review.id}`;
          const next = (won.latest_revision ?? 0) + 1;
          yield* insertAttempt({
            id: attemptId,
            reviewId: review.id,
            revision: next,
            trigger,
            agent: usable,
            at,
            batch,
            capture,
          });
          return next;
        }),
      );
      if (revision === null) return false;
      yield* noteStartedBy(review.key, review.id, attemptId);
      const started: StoredReview =
        review.kind === "local" && source !== null ? { ...review, local: source } : review;
      yield* launch(
        {
          ...started,
          provider: usable.provider,
          instance: usable.instance,
          sessionId: sameGroup.includes(review.instance) ? review.sessionId : null,
        },
        attemptId,
        revision,
        trigger,
      );
      yield* publish(review.key);
      return true;
    }).pipe(Effect.uninterruptible);

  const ensureReview = (
    subject: NewSubject,
    agent: StoredAgent,
    origin: Origin,
    batch: string | null = null,
  ) =>
    Effect.gen(function* () {
      const key = subject.key;
      const existing = yield* findSubject(subject);
      if (existing !== null) return { review: existing, created: false };
      const id = ReviewId.make(yield* newId);
      const attemptId = AttemptId.make(yield* newId);
      const at = yield* now;
      const created = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            INSERT INTO reviews (id, pr_key, account_id, local, provider, instance_id, model, model_options,
              origin, status, current_attempt_id, created_at, updated_at)
            VALUES (${id}, ${key}, ${subject.kind === "pull-request" ? subject.accountId : null},
              ${subject.kind === "local" ? encodeLocal(subject.local) : null}, ${agent.provider},
              ${agent.instance}, ${agent.model}, ${encodeOptions(agent.options)}, ${origin},
              ${encodeStatus({ _tag: "preparing", attemptId })}, ${attemptId}, ${at}, ${at})
            ON CONFLICT (pr_key) DO NOTHING RETURNING id`;
          if (rows.length === 0) return false;
          yield* insertAttempt({
            id: attemptId,
            reviewId: id,
            revision: 1,
            trigger: "first",
            agent,
            at,
            batch,
            capture: subject.kind === "local" ? subject.capture : null,
          });
          return true;
        }),
      );
      const review = yield* findSubject(subject);
      if (review === null)
        return yield* new ReviewError({ message: "prkit couldn't save the review." });
      if (created) {
        yield* Effect.logInfo("Review created").pipe(
          Effect.annotateLogs({
            reviewId: id,
            key,
            ...(subject.kind === "pull-request" ? { accountId: subject.accountId } : {}),
            origin,
            instance: agent.instance,
            model: agent.model ?? "default",
          }),
        );
        yield* noteStartedBy(key, id, attemptId);
        yield* launch(review, attemptId, 1, "first");
        yield* publish(key);
      }
      return { review, created };
    }).pipe(Effect.uninterruptible);

  const get = (key: PullRequestKey) => snapshotOf(key).pipe(Effect.catchTags(dbFailures));

  /**
   * The agent for a new attempt: the one asked for (checked against the catalog),
   * else the review's own, else the default from Settings > Guides.
   */
  const chooseAgent = (requested: AgentSelection | undefined, review: ReviewCore | null) =>
    Effect.gen(function* () {
      if (requested === undefined && review !== null) return storedAgentOf(review);
      const catalog = yield* agents.catalog();
      if (requested !== undefined) {
        const problem = selectionProblem(catalog, requested);
        const entry = findAgentEntry(catalog, requested.instance);
        if (problem !== null || entry === undefined)
          return yield* new ReviewError({ message: problem ?? "Pick an agent." });
        return { ...requested, provider: entry.kind };
      }
      const settings = yield* guideSettings
        .get()
        .pipe(
          Effect.catchTag("GuideSettingsError", (error) =>
            Effect.fail(new ReviewError({ message: error.message })),
          ),
        );
      const chosen = effectiveSelection(catalog, settings.defaultAgent);
      const entry = chosen === null ? undefined : findAgentEntry(catalog, chosen.instance);
      if (chosen === null || entry === undefined)
        return yield* new ReviewError({
          message:
            "No agent is ready to write guides. Sign one in under Settings > Agents, then check again.",
        });
      return { ...chosen, provider: entry.kind };
    });

  /**
   * Starts a guide. `guidance` is the PR's guidance block as typed in the composer;
   * it is saved first, version-checked, so the attempt freezes it with the rest.
   */
  const generate = (
    key: PullRequestKey,
    accountId: AccountId,
    input: { readonly agent?: AgentSelection; readonly guidance?: GuidanceEdit },
  ) =>
    Effect.gen(function* () {
      if (refFromKey(key) === null)
        return yield* new ReviewError({ message: "That doesn't look like a pull request." });
      const existing = yield* findReview(key);
      const agent = yield* chooseAgent(input.agent, existing);
      if (input.guidance !== undefined)
        yield* guideConfig.save({
          scope: { _tag: "pull-request", key },
          expectedVersion: input.guidance.expectedVersion,
          edit: { _tag: "guidance", text: input.guidance.text, mode: input.guidance.mode },
        });
      const { review, created } = yield* ensureReview(
        { kind: "pull-request", key, accountId },
        agent,
        (yield* StartedBy) === null ? "user" : "outside",
      );
      if (!created) {
        const outcome = decide("generate", review.status);
        if (outcome._tag === "start")
          yield* startAttempt(review, review.latestRevision === null ? "first" : "retry", {
            agent,
          });
      }
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * Guides for the chosen layers of the stack `key` is in, bottom to top, with one
   * agent, announced together (docs/internals/architecture.md "Stacks"). Guidance
   * typed in the composer goes to every chosen layer. A new review is bound to the
   * account that read the stack, an existing one keeps its own. A layer that already
   * has a guide is skipped unless `regenerate`; a running or closed one always is.
   */
  const generateStack = (
    key: PullRequestKey,
    accountId: AccountId,
    input: {
      readonly layers: ReadonlyArray<number>;
      readonly regenerate: boolean;
      readonly agent?: AgentSelection;
      readonly guidance?: GuidanceEdit;
    },
  ) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      if (ref === null)
        return yield* new ReviewError({ message: "That doesn't look like a pull request." });
      const stack = yield* pullRequests
        .stack(key, accountId)
        .pipe(
          Effect.catchTag("PullRequestReadError", (error) =>
            Effect.fail(new ReviewError({ message: error.message })),
          ),
        );
      const chosen = stack?.layers.filter((layer) => input.layers.includes(layer.number)) ?? [];
      if (stack === null || chosen.length !== new Set(input.layers).size)
        return yield* new ReviewError({
          message: "The stack changed since you chose its layers. Refresh and choose them again.",
        });
      const agent = yield* chooseAgent(input.agent, yield* findReview(key));
      const own = { _tag: "pull-request" as const, key };
      const shared =
        input.guidance === undefined
          ? (yield* guideConfig.scope(own)).guidance
          : (yield* guideConfig.save({
              scope: own,
              expectedVersion: input.guidance.expectedVersion,
              edit: { _tag: "guidance", text: input.guidance.text, mode: input.guidance.mode },
            })).guidance;
      const plan: Array<{
        readonly key: PullRequestKey;
        readonly review: PullRequestReview | null;
      }> = [];
      const skipped: Array<StackGuidesResult["skipped"][number]> = [];
      for (const layer of chosen) {
        const layerKey = pullRequestKey({ ...ref, number: layer.number });
        const review = yield* findReview(layerKey);
        if (layer.state !== "open") skipped.push({ key: layerKey, reason: "not-open" });
        else if (review?.status._tag === "preparing" || review?.status._tag === "writing")
          skipped.push({ key: layerKey, reason: "running" });
        else if (review !== null && review.latestRevision !== null && !input.regenerate)
          skipped.push({ key: layerKey, reason: "has-guide" });
        else plan.push({ key: layerKey, review });
      }
      if (shared.text !== "")
        for (const item of plan) {
          if (item.key === key) continue;
          const scope = { _tag: "pull-request" as const, key: item.key };
          const current = (yield* guideConfig.scope(scope)).guidance;
          if (current.text === shared.text && current.mode === shared.mode) continue;
          yield* guideConfig.save({
            scope,
            expectedVersion: current.version,
            edit: { _tag: "guidance", text: shared.text, mode: shared.mode },
          });
        }
      const started: Array<PullRequestKey> = [];
      if (plan.length > 0) {
        const batch = yield* newId;
        yield* sql`
          INSERT INTO guide_batches (id, origin_key, account_id, created_at)
          VALUES (${batch}, ${key}, ${accountId}, ${yield* now})`;
        for (const item of plan) {
          const ran =
            item.review === null
              ? (yield* ensureReview(
                  { kind: "pull-request", key: item.key, accountId },
                  agent,
                  "user",
                  batch,
                )).created
              : yield* startAttempt(
                  item.review,
                  item.review.latestRevision === null ? "first" : "retry",
                  { agent, batch },
                );
          if (ran) started.push(item.key);
        }
        yield* Effect.logInfo("Stack guides started").pipe(
          Effect.annotateLogs({ batch, stack: stack.number, started: started.length }),
        );
      }
      return { started, skipped } satisfies StackGuidesResult;
    }).pipe(Effect.catchTags(dbFailures));

  /**
   * Auto mode: a guide for a review request, with the default agent, only if the PR
   * has no review yet. Never starts a second attempt on an existing review.
   */
  const autoGenerate = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      if ((yield* findReview(key)) !== null) return false;
      const agent = yield* chooseAgent(undefined, null);
      const { created } = yield* unattended(
        ensureReview({ kind: "pull-request", key, accountId }, agent, "auto"),
      );
      return created;
    }).pipe(Effect.catchTags(dbFailures));

  /** Auto-started reviews still preparing or writing; auto mode runs one at a time. */
  const autoRunning = sql`
    SELECT COUNT(*) AS count FROM reviews
    WHERE origin = 'auto' AND json_extract(status, '$._tag') IN ('preparing', 'writing')`.pipe(
    Effect.flatMap(decodeCount),
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

  const retry = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const review = yield* findReview(key);
      const outcome = decide("retry", review?.status ?? null);
      if (outcome._tag === "reject")
        return yield* new ReviewStateError({ key, message: outcome.message });
      if (outcome._tag === "start" && review !== null) yield* startAttempt(review, "retry");
      return yield* snapshotOf(key);
    }).pipe(Effect.catchTags(dbFailures));

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

  /** A pull request's Stop; a local review's key is a string too, and stops only through `local`. */
  const stop = (key: PullRequestKey) =>
    (isLocalReviewKey(key) ? Effect.void : end(key, "stopped")).pipe(
      Effect.andThen(snapshotOf(key)),
      Effect.catchTags(dbFailures),
    );

  /** Every review the watcher reads: all pull requests' that are not done. */
  const watched = sql`
    SELECT * FROM reviews WHERE json_extract(status, '$._tag') != 'done' AND local IS NULL`.pipe(
    Effect.flatMap(readablePullRequests),
    Effect.map((rows): ReadonlyArray<WatchedReview> => rows.map(toPullRequestReview)),
  );

  /** Records a watch problem once per distinct message; the next good read clears it. */
  const noteProblem = (review: Review, message: string | null) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE reviews SET watch_problem = ${message}, updated_at = ${at}
        WHERE id = ${review.id} AND json_extract(status, '$._tag') != 'done'
          AND watch_problem IS NOT ${message} RETURNING id`;
      if (rows.length === 0) return;
      yield* message === null
        ? Effect.logInfo("Watcher read the pull request again")
        : Effect.logWarning("Watcher couldn't read the pull request").pipe(
            Effect.annotateLogs({ problem: message }),
          );
      yield* publish(review.key);
    }).pipe(Effect.annotateLogs({ reviewId: review.id, key: review.key }));

  /**
   * Applies one watcher read to a review it saw in `status` (docs/internals/architecture.md
   * "The watcher"). Every write compares and sets, so a review that moved on since the
   * read is left alone.
   */
  const observed = (review: WatchedReview, observation: Observation) =>
    Effect.gen(function* () {
      const action = observe(review.status, observation);
      switch (action._tag) {
        case "none":
          return;
        case "end":
          yield* Effect.logInfo("Pull request ended; ending its review").pipe(
            Effect.annotateLogs({ reviewId: review.id, reason: action.reason }),
          );
          return yield* end(review.key, action.reason);
        case "update": {
          yield* noteProblem(review, null);
          const started = yield* unattended(
            startAttempt(review, "new-commits", { from: ["watching"] }),
          );
          if (started)
            yield* Effect.logInfo("New head; updating the guide").pipe(
              Effect.annotateLogs({ reviewId: review.id, headSha: action.headSha }),
            );
          return;
        }
        case "checked": {
          if (review.status._tag === "watching") {
            const at = yield* now;
            const rows = yield* sql`
              UPDATE reviews SET status = json_set(status, '$.checkedAt', ${at}), watch_problem = NULL,
                updated_at = ${at}
              WHERE id = ${review.id} AND current_attempt_id IS NULL
                AND json_extract(status, '$._tag') = 'watching'
                AND json_extract(status, '$.headSha') = ${review.status.headSha} RETURNING id`;
            if (rows.length > 0) yield* publish(review.key);
            return;
          }
          return yield* noteProblem(review, null);
        }
        case "problem":
          return yield* noteProblem(review, action.message);
        case "fail-account": {
          const at = yield* now;
          const status = {
            _tag: "failed",
            reason: "account",
            message: action.message,
            attemptId: null,
          } satisfies ReviewStatus;
          const rows = yield* sql`
            UPDATE reviews SET status = ${encodeStatus(status)}, updated_at = ${at}
            WHERE id = ${review.id} AND current_attempt_id IS NULL
              AND json_extract(status, '$._tag') = 'watching' RETURNING id`;
          if (rows.length === 0) return;
          yield* Effect.logWarning("GitHub refused the review's account").pipe(
            Effect.annotateLogs({ reviewId: review.id, accountId: review.accountId }),
          );
          yield* publish(review.key);
          return;
        }
      }
    });

  const watch = (key: PullRequestKey): Stream.Stream<ReviewWatchEvent, ReviewError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const subscription = yield* PubSub.subscribe(changes);
        const first = yield* snapshotOf(key);
        let lastId = first.activity.reduce((max, line) => Math.max(max, line.id), 0);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((change) => change.key === key),
          Stream.mapEffect((change) =>
            Effect.gen(function* () {
              const summary = yield* summaryOf(key);
              const activity = change.activity.filter((line) => line.id > lastId);
              lastId = activity.reduce((max, line) => Math.max(max, line.id), lastId);
              const events: ReadonlyArray<ReviewWatchEvent> =
                summary.review === null
                  ? []
                  : [
                      {
                        _tag: "update",
                        review: summary.review,
                        attempt: summary.attempt,
                        revisions: summary.revisions,
                        activity,
                      },
                    ];
              return events;
            }).pipe(Effect.catchTags(dbFailures)),
          ),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        );
        const opening: ReviewWatchEvent = { _tag: "snapshot", snapshot: first };
        return Stream.concat(Stream.succeed(opening), updates);
      }).pipe(Effect.catchTags(dbFailures)),
    );

  /**
   * Startup (docs/internals/architecture.md "Restarts"): attempts an earlier run left
   * unfinished become failed(interrupted) and their reviews start a new attempt;
   * checkouts of done or unknown reviews are removed. A second run changes nothing.
   */
  const reconcile = Effect.gen(function* () {
    const at = yield* now;
    yield* stopUnreadableReviews(at);
    const [readable, unreadable] = yield* sql`SELECT * FROM reviews`.pipe(
      Effect.flatMap(decodeEachReview),
    );
    const stored = new Map(readable.map((row) => [row.id, toStored(row)]));
    const stale = yield* sql`
      SELECT id, review_id, agent_pid, agent_started FROM review_attempts
      WHERE finished_at IS NULL AND run_id != ${runId}`.pipe(Effect.flatMap(decodeStale));
    const message = "prkit stopped while this guide was being written. Starting again.";
    for (const attempt of stale) {
      // An agent outlives a killed server; stop it before its session is resumed.
      if (attempt.agent_pid !== null && attempt.agent_started !== null) {
        const reaped = yield* reapAgentGroup(attempt.agent_pid, attempt.agent_started).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        if (reaped)
          yield* Effect.logInfo("Stopped an agent the previous run left behind").pipe(
            Effect.annotateLogs({ attemptId: attempt.id, pid: attempt.agent_pid }),
          );
      }
      const restarts = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = 'interrupted'
            WHERE id = ${attempt.id} AND finished_at IS NULL`;
          return yield* setStatus(
            attempt.review_id,
            attempt.id,
            { _tag: "failed", reason: "interrupted", message, attemptId: attempt.id },
            null,
          );
        }),
      );
      const review = stored.get(attempt.review_id);
      if (restarts && review !== undefined)
        yield* appendActivity(review.key, review.id, attempt.id, "error", message);
    }
    const interrupted = yield* sql`
      SELECT * FROM reviews WHERE json_extract(status, '$._tag') = 'failed'
        AND json_extract(status, '$.reason') = 'interrupted'`.pipe(Effect.flatMap(readableReviews));
    for (const row of interrupted) {
      const review = toStored(row);
      const attemptId = review.status._tag === "failed" ? review.status.attemptId : null;
      // A stack's guide picks up where it left off and is still announced with the others.
      const batch = attemptId === null ? null : yield* batchOf(attemptId);
      // Local changes are written again from the snapshot that attempt took, not the folder now.
      const capture =
        review.kind === "local" && attemptId !== null
          ? yield* captureOf(attemptId).pipe(
              // A snapshot prkit can't read leaves the review failed, and its Retry says so.
              Effect.catchTag("SchemaError", (error) =>
                Effect.logWarning("Left a local review failed: prkit can't read its snapshot").pipe(
                  Effect.annotateLogs({ attemptId, problem: error.message }),
                  Effect.as(null),
                ),
              ),
            )
          : null;
      if (review.kind === "local" && capture === null) continue;
      yield* unattended(startAttempt(review, "retry", { batch, capture }));
    }
    // A local review's checkout lives only while one of its attempts runs.
    const live = new Set(
      (yield* sql`
        SELECT id FROM reviews WHERE json_extract(status, '$._tag') != 'done'
          AND (local IS NULL OR current_attempt_id IS NOT NULL)`.pipe(
        Effect.flatMap(decodeIds),
      )).map((row) => row.id),
    );
    let removed = 0;
    // A review whose record can't be read keeps its checkout.
    const kept = new Set(unreadable.map((row) => row.id));
    for (const name of yield* repo.listWorktrees()) {
      if (live.has(name) || kept.has(name)) continue;
      const reviewId = ReviewId.make(name);
      // The cache to prune comes from prkit's own record of the review, never the checkout.
      const review = stored.get(reviewId);
      if (yield* repo.removeWorktree(reviewId, review === undefined ? null : cacheOf(review)))
        removed++;
    }
    const unfinished = new Set(
      (yield* sql`SELECT id FROM review_attempts WHERE finished_at IS NULL`.pipe(
        Effect.flatMap(decodeIds),
      )).map((row) => row.id),
    );
    // Each attempt's diffs are named after it, and its temp folder too (`turnTmpDir`).
    for (const name of yield* fs.readDirectory(diffsDir))
      if (!unfinished.has(name)) {
        yield* fs.remove(turnTmpDir(path, name), { recursive: true, force: true });
        yield* fs.remove(path.join(diffsDir, name), { recursive: true, force: true });
      }
    const [locals, unreadableLocals] = yield* sql`
      SELECT id, pr_key FROM reviews WHERE local IS NOT NULL`.pipe(Effect.flatMap(decodeLocalKeys));
    // A copy whose review's key can't be read looks like one whose review is gone: keep them all.
    yield* unreadableLocals.length > 0
      ? Effect.logWarning("Kept every local review's copy: prkit can't read a review's key")
      : repo.local
          .sweep(new Set(locals.map((row) => row.pr_key)))
          .pipe(Effect.catchTag("RepoError", (error) => Effect.logWarning(error.message)));
    yield* Effect.logInfo("Reconciled reviews").pipe(
      Effect.annotateLogs({
        interrupted: stale.length,
        restarted: interrupted.length,
        worktreesRemoved: removed,
      }),
    );
  });

  yield* reconcile;

  const local = yield* makeLocalReviews(
    {
      findLocal,
      locals,
      progressOf,
      activityOf,
      captureOf,
      chooseAgent,
      ensureReview,
      startAttempt,
      end,
      publish,
      changes,
      notices,
    },
    repo.local,
  );

  return {
    get,
    generate,
    generateStack,
    autoGenerate,
    autoRunning,
    retry,
    stop,
    watch,
    index,
    feed,
    guide,
    revisionContext,
    draft,
    diff,
    texts,
    typicalDuration,
    submitGuide,
    reviseGuide,
    submitDraft,
    noteFile,
    reportProgress,
    watched,
    observed,
    local,
  };
});

export const layer = Layer.effect(Reviews, make);
