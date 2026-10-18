import * as Effect from "effect/Effect";
import { type ReviewSnapshot } from "@prkit/contracts";

import { Agents } from "../agents/Agents.ts";
import { ReviewComments } from "../reviewComments/ReviewComments.ts";
import { ReviewedFiles } from "../reviewedFiles/ReviewedFiles.ts";
import { GuideConfigStore } from "../reviews/GuideConfigStore.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { Workspace } from "../workspace/Workspace.ts";
import { requestedAgent } from "./agentSelection.ts";
import { asFailure, fail } from "./errors.ts";
import type { ResolveTarget } from "./OutsideReads.ts";
import type * as Inputs from "./paritySchemas.ts";
import type {
  GenerateGuideInput,
  GuideStatus,
  OpenPullRequestsResult,
  OutsideToolFailure,
  TargetInput,
} from "./schemas.ts";

export const makeOutsideActions = (
  resolve: ResolveTarget,
  guideStatusOf: (snapshot: ReviewSnapshot) => GuideStatus,
  openPullRequests: () => Effect.Effect<OpenPullRequestsResult, OutsideToolFailure>,
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const workspace = yield* Workspace;
    const reviews = yield* Reviews;
    const pulls = yield* PullRequests;
    const guideConfig = yield* GuideConfigStore;
    const comments = yield* ReviewComments;
    const reviewed = yield* ReviewedFiles;

    const close = (input: TargetInput) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        yield* workspace.command({ kind: "close", key: target.key }, { focus: false });
        return yield* openPullRequests();
      }).pipe(Effect.mapError(asFailure));
    const focus = (input: TargetInput) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        yield* workspace.command({ kind: "activate", key: target.key }, { focus: true });
        return yield* openPullRequests();
      }).pipe(Effect.mapError(asFailure));
    const reorder = (input: typeof Inputs.ReorderInput.Type) =>
      workspace
        .command({ kind: "reorder", keys: input.keys }, { focus: false })
        .pipe(Effect.andThen(openPullRequests), Effect.mapError(asFailure));
    const saveInboxFilters = (input: typeof Inputs.SaveInboxFiltersInput.Type) =>
      workspace.saveInboxFilters(input).pipe(Effect.mapError(asFailure));
    const saveGuideSettings = (input: typeof Inputs.SaveGuideSettingsInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        return yield* guideConfig.save({
          scope: { _tag: "pull-request", key: target.key },
          expectedVersion: input.expectedVersion,
          edit: input.edit,
        });
      }).pipe(Effect.mapError(asFailure));

    const markFilesReviewed = (input: typeof Inputs.MarkFilesReviewedInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        return yield* reviewed.decidePaths(
          target,
          input.headSha,
          input.paths,
          input.reviewed ?? true,
        );
      }).pipe(
        Effect.catchTag("ReviewedFilesError", (error) =>
          error.reason === "not-a-changed-file"
            ? fail("invalid", error.message)
            : error.reason === "moved"
              ? fail("conflict", error.message)
              : Effect.fail(asFailure(error)),
        ),
        Effect.mapError(asFailure),
      );

    const generateGuide = (input: typeof GenerateGuideInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const agent = yield* requestedAgent(agents, input);
        const choice = input.stack ?? "this-pr";
        if ((choice === "chosen-layers") !== (input.layers !== undefined))
          return yield* fail(
            "invalid",
            "Use layers only with stack: chosen-layers, and name at least one layer.",
          );
        let layers: ReadonlyArray<number> = [];
        if (choice !== "this-pr") {
          const stack = yield* pulls.stack(target.key, target.accountId);
          if (stack === null)
            return yield* fail(
              "invalid",
              "This pull request isn't in a stack. Use stack: this-pr.",
            );
          layers =
            choice === "whole-stack"
              ? stack.layers.filter((layer) => layer.state === "open").map((layer) => layer.number)
              : (input.layers ?? []);
          if (
            layers.length === 0 ||
            layers.some((number) => !stack.layers.some((layer) => layer.number === number))
          )
            return yield* fail("invalid", "Choose existing stack layers from read_stack.");
        }
        if (input.focus !== undefined)
          yield* guideConfig.save({
            scope: { _tag: "pull-request", key: target.key },
            expectedVersion: input.focus.expectedVersion,
            edit: { _tag: "focus", areas: input.focus.areas, overrides: input.focus.overrides },
          });
        const options = {
          ...(agent === undefined ? {} : { agent }),
          ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
        };
        if (choice !== "this-pr") {
          const result = yield* reviews.generateStack(target.key, target.accountId, {
            ...options,
            layers,
            regenerate: input.regenerate ?? false,
          });
          return { ...guideStatusOf(yield* reviews.get(target.key)), stack: result };
        }
        const snapshot = yield* reviews.generate(target.key, target.accountId, options);
        return { ...guideStatusOf(snapshot), stack: null };
      }).pipe(Effect.mapError(asFailure));

    const editComment = (input: typeof Inputs.EditCommentInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        if (
          !(yield* comments.list(target.key, target.accountId)).comments.some(
            (entry) => entry.id === input.id && entry.state === "draft",
          )
        )
          return yield* fail(
            "not-found",
            "This draft isn't on this pull request and account, or it was already sent. Read list_review_comments again.",
          );
        return yield* comments.edit(input.id, input.body);
      }).pipe(Effect.mapError(asFailure));
    const moveComment = (input: typeof Inputs.MoveCommentInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        if (
          !(yield* comments.list(target.key, target.accountId)).comments.some(
            (entry) => entry.id === input.id && entry.state === "draft",
          )
        )
          return yield* fail(
            "not-found",
            "This draft isn't on this pull request and account, or it was already sent. Read list_review_comments again.",
          );
        return yield* comments.move(input.id, input.placement);
      }).pipe(Effect.mapError(asFailure));

    return {
      close,
      focus,
      reorder,
      saveInboxFilters,
      saveGuideSettings,
      generateGuide,
      editComment,
      moveComment,
      markFilesReviewed,
    };
  });
