import type { ReviewId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { Asks } from "../asks/Asks.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { asFailure, fail } from "./errors.ts";
import type { makeIdempotent } from "./idempotent.ts";
import { makePager } from "./paging.ts";
import type { ResolveTarget } from "./OutsideReads.ts";
import { ACTIVE, askFingerprint, outsideQuestion } from "./questions.ts";
import {
  AskedQuestion,
  type AskAboutInput,
  type PinInput,
  type QuestionInput,
  type ReadQuestionsInput,
  type TargetInput,
  type WaitResult,
} from "./schemas.ts";

const NO_GUIDE = "This pull request has no guide yet.";

/**
 * Questions about a guide for outside agents: the same `Asks` calls the app's panel makes,
 * on the review the PR's account reads.
 */
export const makeOutsideAsks = (
  resolve: ResolveTarget,
  idempotent: Effect.Success<typeof makeIdempotent>,
) =>
  Effect.gen(function* () {
    const page = yield* makePager;
    const asks = yield* Asks;
    const reviews = yield* Reviews;

    /** The review whose guide questions are about; a PR with none has nothing to ask. */
    const reviewOf = (input: TargetInput) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const review = (yield* reviews.get(target.key)).review;
        if (review === null) return yield* fail("not-found", NO_GUIDE);
        // Answers come from the conversation that wrote the guide, author's pre-flight and all,
        // so like the pre-flight (forReader) they are only the review's own account's.
        if (review.accountId !== target.accountId)
          return yield* fail(
            "account-needed",
            `Questions about this guide go through ${review.accountId}, the account it was written for. Pass that accountId.`,
          );
        return { target, review };
      });

    /** A question on this PR's review, so a question id from another PR does nothing here. */
    const questionOnThisPullRequest = (input: typeof QuestionInput.Type) =>
      Effect.gen(function* () {
        const { target, review } = yield* reviewOf(input);
        const question = (yield* asks.list(review.id)).find(
          (entry) => entry.id === input.questionId,
        );
        if (question === undefined)
          return yield* fail(
            "not-found",
            "This question isn't on this pull request. Read read_pull_request_questions for its ids.",
          );
        return { target, question };
      });

    const questions = (input: typeof ReadQuestionsInput.Type) =>
      Effect.gen(function* () {
        const { target, review } = yield* reviewOf(input);
        const rows = (yield* asks.list(review.id, input.revision)).map(outsideQuestion);
        return yield* page(
          rows,
          input,
          `questions:${target.accountId}:${target.key}:${input.revision ?? "all"}`,
        );
      }).pipe(Effect.mapError(asFailure));

    const askQuestion = (input: typeof AskAboutInput.Type) =>
      Effect.gen(function* () {
        const { target, review } = yield* reviewOf(input);
        const revision = input.revision ?? review.latestRevision;
        if (revision === null) return yield* fail("not-found", NO_GUIDE);
        const scope = input.scope ?? { _tag: "pull-request" as const };
        const text = input.question.trim();
        return yield* idempotent(
          {
            tool: "ask_about_pull_request",
            clientRequestId: input.clientRequestId,
            key: target.key,
            input: askFingerprint(input.revision, scope, text),
          },
          AskedQuestion,
          asks.ask({ reviewId: review.id, revision, scope, text }).pipe(
            Effect.map((question) => ({
              key: target.key,
              questionId: question.id,
              revision: question.revision,
              state: question.state._tag,
            })),
          ),
        );
      }).pipe(Effect.mapError(asFailure));

    const stopQuestion = (input: typeof QuestionInput.Type) =>
      Effect.gen(function* () {
        const { question } = yield* questionOnThisPullRequest(input);
        return outsideQuestion(yield* asks.stop(question.id));
      }).pipe(Effect.mapError(asFailure));

    const pinAnswer = (input: typeof PinInput.Type) =>
      Effect.gen(function* () {
        const { question } = yield* questionOnThisPullRequest(input);
        return outsideQuestion(yield* asks.pin(question.id, input.pinned));
      }).pipe(Effect.mapError(asFailure));

    /**
     * Waits on the stream the app's panel watches, until no question on the review is being
     * answered. A timeout stops the waiting, never the question.
     */
    const waitForQuestion = (input: TargetInput, timeout: `${number} seconds`) =>
      Effect.gen(function* () {
        const { review } = yield* reviewOf(input);
        const newest = (reviewId: ReviewId) =>
          asks.list(reviewId).pipe(Effect.map((rows) => rows.at(-1)));
        if ((yield* newest(review.id)) === undefined)
          return yield* fail("not-found", "No question was asked about this pull request.");
        const settled = yield* asks.watch(review.id).pipe(
          Stream.filter((event) => event._tag === "snapshot" || event._tag === "question"),
          Stream.mapEffect(() => asks.list(review.id)),
          Stream.filter((rows) => !rows.some((row) => ACTIVE.has(row.state._tag))),
          Stream.runHead,
          Effect.timeoutOption(timeout),
        );
        const latest = yield* newest(review.id);
        const result: WaitResult = {
          finished: Option.isSome(settled) && Option.isSome(settled.value),
          guide: null,
          fix: null,
          question: latest === undefined ? null : outsideQuestion(latest),
        };
        return result;
      }).pipe(Effect.mapError(asFailure));

    return { questions, askQuestion, stopQuestion, pinAnswer, waitForQuestion };
  });
