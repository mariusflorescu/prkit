import type { LocalReviewError, LocalReviewKey, LocalReviewSnapshot } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { Agents } from "../agents/Agents.ts";
import { Asks } from "../asks/Asks.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { Workspace } from "../workspace/Workspace.ts";
import { requestedAgent } from "./agentSelection.ts";
import { asFailure, fail } from "./errors.ts";
import type { makeIdempotent } from "./idempotent.ts";
import { makePager } from "./paging.ts";
import { ACTIVE, askFingerprint, outsideQuestion } from "./questions.ts";
import {
  AskedLocalQuestion,
  type AskAboutLocalInput,
  type GenerateLocalGuideInput,
  type GenerateLocalGuideResult,
  type LocalGuideResult,
  type LocalGuideStatus,
  type LocalListInput,
  type LocalListResult,
  type LocalQuestionInput,
  type LocalTargetInput,
  type LocalWaitInput,
  type LocalWaitResult,
  type OutsideToolFailure,
  type PinLocalInput,
  type ReadLocalGuideInput,
  type ReadLocalQuestionsInput,
  type LocalQuestionWaitInput,
  type LocalQuestionWaitResult,
} from "./schemas.ts";

const WAIT_DEFAULT_SECONDS = 50;

/** A repository problem crosses as something the client can act on; the sentence is the user's. */
const CODES: Record<LocalReviewError["reason"], OutsideToolFailure["code"]> = {
  "not-a-repository": "invalid",
  "bare-repository": "invalid",
  "not-owned": "invalid",
  "prkit-checkout": "invalid",
  "sparse-checkout": "invalid",
  "no-commits": "invalid",
  "branch-not-found": "invalid",
  "base-not-found": "invalid",
  "no-shared-history": "invalid",
  "nothing-changed": "invalid",
  "too-large": "invalid",
  moved: "invalid",
  "not-found": "not-found",
  "missing-objects": "failed",
  "repository-changed": "failed",
};
const repositoryProblem = {
  LocalReviewError: (error: LocalReviewError) => fail(CODES[error.reason], error.message),
};

const NO_REVIEW =
  "There's no local review for this branch yet. Start one with generate_local_guide (`prkit local guide`).";
const NO_GUIDE =
  "These local changes have no guide yet. Generate one first with generate_local_guide (`prkit local guide`).";
const NO_QUESTION =
  "This question isn't on this local review. Read read_local_questions for its ids.";
const REMOVED = "This local review was removed, and its questions went with it.";

/** The outside word for a local review's state: never "watching", since nothing watches it. */
const statusOf = (snapshot: LocalReviewSnapshot): LocalGuideStatus | null => {
  const { review, attempt, run } = snapshot;
  if (review === null) return null;
  const status = review.status;
  const running = status._tag === "preparing" || status._tag === "writing";
  return {
    key: review.key,
    name: review.source.name,
    path: review.source.path,
    branch: review.source.branch,
    state: status._tag === "done" ? "stopped" : status._tag,
    message:
      status._tag === "failed"
        ? status.message
        : status._tag === "done"
          ? "Stopped. Generate it again for a new revision."
          : null,
    latestRevision: review.latestRevision,
    agent: { instance: review.instance, model: review.model },
    startedBy: attempt?.startedBy ?? null,
    run:
      run === null
        ? null
        : {
            baseRef: run.baseRef,
            head: run.head,
            commits: run.commitCount,
            uncommitted: run.uncommitted,
            description: run.description,
            leftOut: run.leftOut,
          },
    progress:
      running && attempt !== null
        ? {
            narration: attempt.narration,
            filesRead: attempt.files.filter((file) => file.read === "read").length,
            files: attempt.files.length,
          }
        : null,
  };
};

/**
 * Guides of local changes, and questions about them, for outside agents and the CLI. A local
 * review is named by its key or by a folder, never by an account: these tools reach only
 * Reviews, Asks and Agents.
 */
export const makeOutsideLocal = (idempotent: Effect.Success<typeof makeIdempotent>) =>
  Effect.gen(function* () {
    const reviews = yield* Reviews;
    const agents = yield* Agents;
    const asks = yield* Asks;
    const workspace = yield* Workspace;
    const page = yield* makePager;

    const keyOf = (input: LocalTargetInput) =>
      input.key !== undefined
        ? Effect.succeed(input.key)
        : input.path === undefined
          ? fail(
              "invalid",
              "Name the local review by key, or by an absolute path inside its repository.",
            )
          : reviews.local.keyOf({
              _tag: "path",
              path: input.path,
              ...(input.branch === undefined ? {} : { branch: input.branch }),
            });

    /** The review and its status now, or `not-found`. */
    const existing = (key: LocalReviewKey) =>
      reviews.local.get(key).pipe(
        Effect.flatMap((snapshot) => {
          const status = statusOf(snapshot);
          return snapshot.review === null || status === null
            ? fail("not-found", NO_REVIEW)
            : Effect.succeed({ snapshot, review: snapshot.review, status });
        }),
      );

    const generateLocal = (input: typeof GenerateLocalGuideInput.Type) =>
      Effect.gen(function* () {
        const agent = yield* requestedAgent(agents, input);
        const result = yield* reviews.local.generate({
          target: {
            _tag: "path",
            path: input.path,
            ...(input.branch === undefined ? {} : { branch: input.branch }),
          },
          ...(input.base === undefined ? {} : { base: input.base }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.regenerate === undefined ? {} : { regenerate: input.regenerate }),
          ...(agent === undefined ? {} : { agent }),
        });
        const status = statusOf(result.snapshot);
        if (status === null)
          return yield* fail("failed", "prkit couldn't save the review. Try again.");
        // Its tab shows in the app's strip, without taking the user away from what they read.
        yield* workspace
          .command({ kind: "open-local", key: status.key }, { focus: false })
          .pipe(
            Effect.catchTag("WorkspaceError", (error) =>
              Effect.logWarning("Local review tab not opened").pipe(
                Effect.annotateLogs({ reason: error.message }),
              ),
            ),
          );
        return {
          outcome: result.outcome,
          message: result.message,
          status,
        } satisfies GenerateLocalGuideResult;
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const readLocal = (input: typeof ReadLocalGuideInput.Type) =>
      Effect.gen(function* () {
        const key = yield* keyOf(input);
        const { status } = yield* existing(key);
        const revision = input.revision ?? status.latestRevision;
        const guide = revision === null ? null : yield* reviews.guide(key, revision);
        return {
          status,
          guide:
            guide === null
              ? null
              : { revision: guide.revision, createdAt: guide.createdAt, content: guide.normalized },
        } satisfies LocalGuideResult;
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const waitLocal = (input: typeof LocalWaitInput.Type) =>
      Effect.gen(function* () {
        const key = yield* keyOf(input);
        yield* existing(key);
        const settled = yield* reviews.local.watch(key).pipe(
          Stream.map((event) =>
            event._tag === "snapshot"
              ? event.snapshot.review?.status._tag
              : event._tag === "update"
                ? event.review.status._tag
                : "removed",
          ),
          Stream.filter((state) => state !== "preparing" && state !== "writing"),
          Stream.runHead,
          Effect.timeoutOption(`${input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS} seconds`),
        );
        const { status } = yield* existing(key);
        return {
          finished: Option.isSome(settled) && Option.isSome(settled.value),
          status,
        } satisfies LocalWaitResult;
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const stopLocal = (input: LocalTargetInput) =>
      Effect.gen(function* () {
        const key = yield* keyOf(input);
        yield* existing(key);
        const status = statusOf(yield* reviews.local.stop(key));
        return status === null ? yield* fail("not-found", NO_REVIEW) : status;
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const listLocal = (input: typeof LocalListInput.Type) =>
      Effect.gen(function* () {
        const entries = yield* reviews.local.list();
        const paged = yield* page(
          entries,
          input,
          `local:${entries.map((entry) => `${entry.key}:${entry.updatedAt}`).join(",")}`,
        );
        const items = yield* Effect.forEach(paged.items, (entry) =>
          reviews.local.get(entry.key).pipe(Effect.map(statusOf)),
        );
        return {
          nextCursor: paged.nextCursor,
          total: paged.total,
          truncated: paged.truncated,
          message: paged.message,
          items: items.flatMap((status) => (status === null ? [] : [status])),
        } satisfies LocalListResult;
      }).pipe(Effect.mapError(asFailure));

    /** The review whose guide questions are about; one without a guide has nothing to ask. */
    const guidedReview = (input: LocalTargetInput) =>
      Effect.gen(function* () {
        const { review } = yield* existing(yield* keyOf(input));
        if (review.latestRevision === null) return yield* fail("not-found", NO_GUIDE);
        return { review, latest: review.latestRevision };
      });

    /** A question on this review, so a question id from another review does nothing here. */
    const questionOnThisReview = (input: typeof LocalQuestionInput.Type) =>
      Effect.gen(function* () {
        const { review } = yield* guidedReview(input);
        const question = (yield* asks.list(review.id)).find(
          (entry) => entry.id === input.questionId,
        );
        if (question === undefined) return yield* fail("not-found", NO_QUESTION);
        return { review, question };
      }).pipe(Effect.catchTags(repositoryProblem));

    const questionsLocal = (input: typeof ReadLocalQuestionsInput.Type) =>
      Effect.gen(function* () {
        const { review } = yield* guidedReview(input);
        const rows = (yield* asks.list(review.id, input.revision)).map(outsideQuestion);
        return yield* page(rows, input, `local-questions:${review.key}:${input.revision ?? "all"}`);
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const askLocal = (input: typeof AskAboutLocalInput.Type) =>
      Effect.gen(function* () {
        const { review, latest } = yield* guidedReview(input);
        const scope = input.scope ?? { _tag: "local-changes" as const };
        const text = input.question.trim();
        return yield* idempotent(
          {
            tool: "ask_about_local_changes",
            clientRequestId: input.clientRequestId,
            key: review.key,
            input: askFingerprint(input.revision, scope, text),
          },
          AskedLocalQuestion,
          asks.ask({ reviewId: review.id, revision: input.revision ?? latest, scope, text }).pipe(
            Effect.map((question) => ({
              key: review.key,
              questionId: question.id,
              revision: question.revision,
              state: question.state._tag,
            })),
          ),
        );
      }).pipe(Effect.catchTags(repositoryProblem), Effect.mapError(asFailure));

    const stopLocalQuestion = (input: typeof LocalQuestionInput.Type) =>
      Effect.gen(function* () {
        const { question } = yield* questionOnThisReview(input);
        return outsideQuestion(yield* asks.stop(question.id));
      }).pipe(Effect.mapError(asFailure));

    const pinLocalAnswer = (input: typeof PinLocalInput.Type) =>
      Effect.gen(function* () {
        const { question } = yield* questionOnThisReview(input);
        return outsideQuestion(yield* asks.pin(question.id, input.pinned));
      }).pipe(Effect.mapError(asFailure));

    /**
     * Waits on the streams the app's panel watches until the question is answered, stopped or
     * failed. A removed review takes its questions with it, so the wait ends there. A timeout
     * stops the waiting, never the question.
     */
    const waitForLocalQuestion = (input: typeof LocalQuestionWaitInput.Type) =>
      Effect.gen(function* () {
        const { review, question: asked } = yield* questionOnThisReview(input);
        const current = asks
          .list(review.id)
          .pipe(Effect.map((rows) => rows.find((row) => row.id === asked.id)));
        const settled = yield* Stream.merge(
          asks
            .watch(review.id)
            .pipe(Stream.filter((event) => event._tag === "snapshot" || event._tag === "question")),
          reviews.local.watch(review.key).pipe(Stream.filter((event) => event._tag === "removed")),
        ).pipe(
          Stream.mapEffect(() => current),
          Stream.filter((question) => question === undefined || !ACTIVE.has(question.state._tag)),
          Stream.runHead,
          Effect.timeoutOption(`${input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS} seconds`),
        );
        const latest = yield* current;
        if (latest === undefined) return yield* fail("not-found", REMOVED);
        return {
          finished: Option.isSome(settled) && Option.isSome(settled.value),
          question: outsideQuestion(latest),
        } satisfies LocalQuestionWaitResult;
      }).pipe(Effect.mapError(asFailure));

    return {
      generateLocal,
      readLocal,
      waitLocal,
      stopLocal,
      listLocal,
      questionsLocal,
      askLocal,
      stopLocalQuestion,
      pinLocalAnswer,
      waitForLocalQuestion,
    };
  });
