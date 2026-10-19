import {
  AttemptId,
  type GuideRepository,
  isAccountLogin,
  NormalizedGuide,
  PullRequestKey,
  type PullRequestRef,
  type PullRequestStack,
  type ResolvedGuideConfig,
  type Review,
  ReviewId,
  refFromKey,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubApi, GitHubPriority } from "../github/GitHubApi.ts";
import { type CacheRef, type Prepared } from "../repo/RepoCache.ts";
import { ContextPriority } from "./ContextPriority.ts";
import { contextJson, contextNotes } from "./contextFile.ts";
import { type PromptSubject } from "./prompt.ts";
import { reviewTarget } from "./reviewTarget.ts";
import {
  AttemptFailure,
  cacheOf,
  type LocalStoredReview,
  type PullRequestReview,
  type ReviewStore,
} from "./reviewStore.ts";

export const fail = (reason: AttemptFailure["reason"], message: string) =>
  Effect.fail(new AttemptFailure({ reason, message }));

export const PreviousRow = Schema.Struct({
  revision: Schema.Int,
  head_sha: Schema.String,
  /** Null for revisions written before prkit kept it. */
  base_ref: Schema.NullOr(Schema.String),
  guide: Schema.fromJsonString(NormalizedGuide),
  config_hash: Schema.String,
});

const decodePrevious = Schema.decodeUnknownEffect(Schema.Array(PreviousRow));

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
export type PullRequestFront =
  | { readonly _tag: "plan"; readonly plan: AttemptPlan }
  | { readonly _tag: "ended"; readonly key: PullRequestKey; readonly state: "merged" | "closed" };

/** What an attempt reads before its agent starts: the last revision, the stack, the context, and the subject's diff. */
export const makeAttemptPlans = ({
  sql,
  path,
  repo,
  accounts,
  api,
  guideConfig,
  pullRequests,
  diffsDir,
  captureOf,
  appendActivity,
}: ReviewStore) => {
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

  /** The last accepted revision, for an attempt that may update its guide. */
  const previousOf = (reviewId: ReviewId) =>
    sql`
      SELECT r.revision, r.head_sha, a.base_ref, r.guide, a.config_hash FROM review_revisions r
      JOIN review_attempts a ON a.id = r.attempt_id
      WHERE r.review_id = ${reviewId} ORDER BY r.revision DESC LIMIT 1`.pipe(
      Effect.flatMap(decodePrevious),
      Effect.map((rows) => rows[0] ?? null),
    );

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

  return { previousOf, pullRequestPlan, localPlan };
};
