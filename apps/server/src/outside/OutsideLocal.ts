import type { LocalReviewError, LocalReviewKey, LocalReviewSnapshot } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { Agents } from "../agents/Agents.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { requestedAgent } from "./agentSelection.ts";
import { asFailure, fail } from "./errors.ts";
import { makePager } from "./paging.ts";
import type {
  GenerateLocalGuideInput,
  GenerateLocalGuideResult,
  LocalGuideResult,
  LocalGuideStatus,
  LocalListInput,
  LocalListResult,
  LocalTargetInput,
  LocalWaitInput,
  LocalWaitResult,
  OutsideToolFailure,
  ReadLocalGuideInput,
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
 * Guides of local changes for outside agents and the CLI. A local review is named by its key
 * or by a folder, never by an account: these tools reach only Reviews and Agents.
 */
export const makeOutsideLocal = Effect.gen(function* () {
  const reviews = yield* Reviews;
  const agents = yield* Agents;
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

  /** The review's status now, or `not-found`. */
  const existing = (key: LocalReviewKey) =>
    reviews.local.get(key).pipe(
      Effect.flatMap((snapshot) => {
        const status = statusOf(snapshot);
        return status === null
          ? fail("not-found", NO_REVIEW)
          : Effect.succeed({ snapshot, status });
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

  return { generateLocal, readLocal, waitLocal, stopLocal, listLocal };
});
