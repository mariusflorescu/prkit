import { type AgentSelection, AttemptId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { type AgentProvider, GUIDE_TOOLS } from "../agents/AgentProvider.ts";
import type { FileRead } from "../agents/commandReads.ts";
import { processStartTime } from "../agents/agentProcess.ts";
import { type Checkout } from "../repo/RepoCache.ts";
import { makeGuideStream } from "./guideStream.ts";
import {
  AttemptFailure,
  type PendingRead,
  type ReadContext,
  type ReviewStore,
  type StoredReview,
} from "./reviewStore.ts";
import { type makeGuideTools } from "./guideTools.ts";

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

/** The guide agent's turn: its run, what it reads, and the draft it streams. */
export const makeAttemptTurn = (
  {
    sql,
    path,
    repo,
    agents,
    tokens,
    spawner,
    mcpUrl,
    instructions,
    reading,
    growing,
    readContexts,
    now,
    publish,
    appendActivity,
    setPhase,
  }: ReviewStore,
  { streamDraft, draftChapters }: ReturnType<typeof makeGuideTools>,
) => {
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
                    Effect.annotateLogs({ outcome: event.outcome }),
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

  return { storedGuide, runTurn };
};
