import {
  type AccountId,
  AccountId as AccountIdSchema,
  AgentInstanceId,
  type AgentSelection,
  AgentProviderKind,
  AttemptConfig,
  type AttemptFile,
  AttemptId,
  AttemptTrigger,
  checkContextOf,
  coverageProblems,
  DiffSnapshot,
  type DoneReason,
  DraftGuide,
  everythingSkippedMessage,
  type DraftGuideResult,
  effectiveSelection,
  FailureReason,
  findAgentEntry,
  findAgentModel,
  type GuidanceEdit,
  type Guide,
  GuideNotFoundError,
  type GuidePatch,
  type GuideRepository,
  type GuideRevision,
  isLocalReviewKey,
  LocalReviewKey,
  LocalSource,
  mergeDraft,
  ModelOptionSelection,
  NormalizedGuide,
  normalizeDraft,
  normalizeGuide,
  patchGuide,
  projectSnapshot,
  PullRequestKey,
  type PullRequestRef,
  pullRequestKey,
  type PullRequestStack,
  type ResolvedGuideConfig,
  resolveModelOptions,
  type Review,
  type ReviewActivity,
  type ReviewCore,
  ReviewActivityKind,
  ReviewError,
  type ReviewFeedEntry,
  type ReviewFeedEvent,
  ReviewId,
  ReviewKey,
  ReviewPhase,
  type ReviewSnapshot,
  ReviewStateError,
  ReviewStatus,
  type ReviewWatchEvent,
  refFromKey,
  reviewedSnapshot,
  riskSignals,
  SKIPPED_CHAPTER_ID,
  selectionProblem,
  type StackGuidesResult,
  type TypicalDuration,
  withoutUnwrittenChapters,
  withSkippedChapter,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import { HttpServer } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { type AgentProvider, GUIDE_TOOLS } from "../agents/AgentProvider.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import type { FileRead } from "../agents/commandReads.ts";
import { processStartTime, reapAgentGroup } from "../agents/agentProcess.ts";
import { Agents } from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { GitHubApi, GitHubPriority } from "../github/GitHubApi.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { boundPort } from "../listenAddress.ts";
import { McpTokens } from "../mcp/McpTokens.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { LocalCapture } from "../repo/localCapture.ts";
import {
  type CacheRef,
  type Checkout,
  type Prepared,
  RepoCache,
  type Since,
} from "../repo/RepoCache.ts";
import { ContextPriority, unattended } from "./ContextPriority.ts";
import { contextJson, contextNotes } from "./contextFile.ts";
import { GuideConfigStore } from "./GuideConfigStore.ts";
import { makeGuideStream } from "./guideStream.ts";
import { GuideSettingsStore } from "./GuideSettingsStore.ts";
import { decide, type Observation, observe, STARTABLE } from "./lifecycle.ts";
import { makeLocalReviews } from "./localReviews.ts";
import {
  buildPrompt,
  type DiffSection,
  NUDGE_PROMPT,
  numberedDiff,
  type PromptInput,
  type PromptSubject,
} from "./prompt.ts";
import { reviewTarget } from "./reviewTarget.ts";
import { StartedBy } from "../outside/StartedBy.ts";

export const SubmitGuideReceipt = Schema.Struct({
  message: Schema.String,
  chapters: Schema.Int,
  files: Schema.Int,
  warnings: Schema.Array(Schema.String),
});
export type SubmitGuideReceipt = typeof SubmitGuideReceipt.Type;

/** `submit_guide` failed; the message goes back to the agent as the tool result. */
export class SubmitGuideRejected extends Schema.TaggedError<SubmitGuideRejected>()(
  "SubmitGuideRejected",
  { message: Schema.String },
) {}

/** A second call in a turn that already handed prkit its guide, such as a parallel tool call. */
const ALREADY_STORED =
  "prkit already has this attempt's guide, so it won't use this one. End your turn now.";
const NO_LONGER_CURRENT =
  "This attempt is no longer current, so prkit won't use this guide. End your turn now.";

/** What `report_progress`, `note_file` and `submit_draft` answer the agent. */
export const ToolReceipt = Schema.Struct({ message: Schema.String });
export type ToolReceipt = typeof ToolReceipt.Type;

/** One of the progress tools refused the call; the message goes back to the agent. */
export class ToolRejected extends Schema.TaggedError<ToolRejected>()("ToolRejected", {
  message: Schema.String,
}) {}

/** Ends an attempt as `failed(reason)`. */
class AttemptFailure extends Schema.TaggedError<AttemptFailure>()("AttemptFailure", {
  reason: Schema.Literals([
    "account",
    "github",
    "repository",
    "agent-auth",
    "agent",
    "no-guide",
    "interrupted",
    "settings",
  ]),
  message: Schema.String,
}) {}
const fail = (reason: FailureReason, message: string) =>
  Effect.fail(new AttemptFailure({ reason, message }));

const ReviewFields = {
  id: ReviewId,
  provider: AgentProviderKind,
  instance_id: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  model_options: Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
  session_id: Schema.NullOr(Schema.String),
  status: Schema.fromJsonString(ReviewStatus),
  current_attempt_id: Schema.NullOr(AttemptId),
  latest_revision: Schema.NullOr(Schema.Int),
  watch_problem: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
};
const PullRequestRow = Schema.Struct({
  ...ReviewFields,
  pr_key: PullRequestKey,
  account_id: AccountIdSchema,
  local: Schema.Null,
});
const LocalRow = Schema.Struct({
  ...ReviewFields,
  pr_key: LocalReviewKey,
  account_id: Schema.Null,
  local: Schema.fromJsonString(LocalSource),
});
/** A pull request's review with its account, or a review of local changes, with none. */
export const ReviewRow = Schema.Union([PullRequestRow, LocalRow]);
const OutlineChapters = Schema.Array(
  Schema.Struct({ id: Schema.String, title: Schema.String, written: Schema.Boolean }),
);
export const AttemptRow = Schema.Struct({
  id: AttemptId,
  revision: Schema.Int,
  trigger: AttemptTrigger,
  phase: ReviewPhase,
  head_sha: Schema.NullOr(Schema.String),
  commits: Schema.NullOr(Schema.Int),
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  narration: Schema.NullOr(Schema.String),
  started_by: Schema.NullOr(Schema.String),
  draft_outline: Schema.NullOr(Schema.fromJsonString(OutlineChapters)),
  draft_version: Schema.Int,
});
const FileRow = Schema.Struct({
  path: Schema.String,
  previous_path: Schema.NullOr(Schema.String),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  additions: Schema.Int,
  deletions: Schema.Int,
  read_at: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
const RevisionRow = Schema.Struct({
  revision: Schema.Int,
  attempt_id: AttemptId,
  trigger: AttemptTrigger,
  head_sha: Schema.String,
  created_at: Schema.String,
});
const PreviousRow = Schema.Struct({
  revision: Schema.Int,
  head_sha: Schema.String,
  /** Null for revisions written before prkit kept it. */
  base_ref: Schema.NullOr(Schema.String),
  guide: Schema.fromJsonString(NormalizedGuide),
  config_hash: Schema.String,
});
const ActivityRow = Schema.Struct({
  id: Schema.Int,
  attempt_id: AttemptId,
  at: Schema.String,
  kind: ReviewActivityKind,
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
const SubmitRow = Schema.Struct({
  review_id: ReviewId,
  pr_key: ReviewKey,
  current_attempt_id: Schema.NullOr(AttemptId),
  finished_at: Schema.NullOr(Schema.String),
  snapshot: Schema.NullOr(Schema.fromJsonString(DiffSnapshot)),
  draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)),
  config: Schema.NullOr(Schema.fromJsonString(AttemptConfig)),
});
/** The attempt's guide once one passed, as stored. */
const CheckRow = Schema.Struct({ ...SubmitRow.fields, guide: Schema.NullOr(Schema.String) });
const DraftRow = Schema.Struct({
  snapshot: Schema.NullOr(Schema.fromJsonString(DiffSnapshot)),
  draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)),
  config: Schema.NullOr(Schema.fromJsonString(AttemptConfig)),
  draft_version: Schema.Int,
});
const FeedRow = Schema.Struct({
  pr_key: PullRequestKey,
  account_id: AccountIdSchema,
  status: Schema.fromJsonString(ReviewStatus),
  latest_revision: Schema.NullOr(Schema.Int),
});
const DurationRow = Schema.Struct({ seconds: Schema.Number });
const GuideRow = Schema.Struct({
  revision: Schema.Int,
  head_sha: Schema.String,
  created_at: Schema.String,
  guide: Schema.fromJsonString(NormalizedGuide),
  snapshot: Schema.fromJsonString(DiffSnapshot),
  config: Schema.fromJsonString(AttemptConfig),
});
const IdRow = Schema.Struct({ id: Schema.String });
const StaleRow = Schema.Struct({
  id: AttemptId,
  review_id: ReviewId,
  agent_pid: Schema.NullOr(Schema.Int),
  agent_started: Schema.NullOr(Schema.String),
});

const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewRow));
const decodePullRequests = Schema.decodeUnknownEffect(Schema.Array(PullRequestRow));
const decodeLocals = Schema.decodeUnknownEffect(Schema.Array(LocalRow));
const decodeAttempts = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
const decodeRevisions = Schema.decodeUnknownEffect(Schema.Array(RevisionRow));
const decodePrevious = Schema.decodeUnknownEffect(Schema.Array(PreviousRow));
const decodeActivity = Schema.decodeUnknownEffect(Schema.Array(ActivityRow));
const decodeFiles = Schema.decodeUnknownEffect(Schema.Array(FileRow));
const decodeSubmit = Schema.decodeUnknownEffect(Schema.Array(SubmitRow));
const decodeCheck = Schema.decodeUnknownEffect(Schema.Array(CheckRow));
const decodeDraft = Schema.decodeUnknownEffect(Schema.Array(DraftRow));
const decodeDraftOnly = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)) })),
);
const decodeHeads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ head_sha: Schema.NullOr(Schema.String) })),
);
const decodeFeed = Schema.decodeUnknownEffect(Schema.Array(FeedRow));
const decodeDurations = Schema.decodeUnknownEffect(Schema.Array(DurationRow));
const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })));
const decodeGuides = Schema.decodeUnknownEffect(Schema.Array(GuideRow));
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow));
const decodeStale = Schema.decodeUnknownEffect(Schema.Array(StaleRow));
const decodeStarted = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ latest_revision: Schema.NullOr(Schema.Int) })),
);
const decodeInserted = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int })));
const decodeBatch = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ batch_id: Schema.NullOr(Schema.String) })),
);
const decodeOutcomes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      finished_at: Schema.NullOr(Schema.String),
      outcome: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeCaptures = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ capture: Schema.NullOr(Schema.fromJsonString(LocalCapture)) })),
);
const decodeLocalKeys = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ pr_key: LocalReviewKey })),
);
const decodeClaimed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin_key: PullRequestKey, account_id: AccountIdSchema })),
);
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(ReviewStatus));
const encodeGuide = Schema.encodeSync(Schema.fromJsonString(NormalizedGuide));
/** The previous guide as the agent reads it: indented, so no line is too long to read. */
const encodeReadableGuide = Schema.encodeSync(
  Schema.fromJsonString(NormalizedGuide.mapFields(Struct.omit(["signals"])), { space: 2 }),
);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(DiffSnapshot));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AttemptConfig));
const encodeDraft = Schema.encodeSync(Schema.fromJsonString(DraftGuide));
const encodeOutline = Schema.encodeSync(Schema.fromJsonString(OutlineChapters));
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ModelOptionSelection)));
const encodeLocal = Schema.encodeSync(Schema.fromJsonString(LocalSource));
const encodeCapture = Schema.encodeSync(Schema.fromJsonString(LocalCapture));

/** A pull request's review. */
interface PullRequestReview extends Review {
  readonly kind: "pull-request";
}
/** A review of local changes. It has no account to read anything through. */
export interface LocalStoredReview extends ReviewCore {
  readonly kind: "local";
  readonly key: LocalReviewKey;
  readonly local: LocalSource;
}
export type StoredReview = PullRequestReview | LocalStoredReview;
/** What the watcher reads and applies its reads to: pull requests only. */
export type WatchedReview = PullRequestReview;

const coreOf = (row: typeof ReviewRow.Type): ReviewCore => ({
  id: row.id,
  provider: row.provider,
  instance: row.instance_id,
  model: row.model,
  modelOptions: row.model_options,
  sessionId: row.session_id,
  status: row.status,
  latestRevision: row.latest_revision,
  watchProblem: row.watch_problem,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const toPullRequestReview = (row: typeof PullRequestRow.Type): PullRequestReview => ({
  kind: "pull-request",
  ...coreOf(row),
  key: row.pr_key,
  accountId: row.account_id,
});
const toLocalReview = (row: typeof LocalRow.Type): LocalStoredReview => ({
  kind: "local",
  ...coreOf(row),
  key: row.pr_key,
  local: row.local,
});
const toStored = (row: typeof ReviewRow.Type): StoredReview =>
  row.local === null ? toPullRequestReview(row) : toLocalReview(row);
/** The review as the pull request APIs answer it. */
const toReview = (review: PullRequestReview): Review => ({
  id: review.id,
  key: review.key,
  accountId: review.accountId,
  provider: review.provider,
  instance: review.instance,
  model: review.model,
  modelOptions: review.modelOptions,
  sessionId: review.sessionId,
  status: review.status,
  latestRevision: review.latestRevision,
  watchProblem: review.watchProblem,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});
/** Where a review's objects live; null for a pull request whose key can't be read. */
const cacheOf = (review: StoredReview): CacheRef | null => {
  if (review.kind === "local") return { _tag: "local", key: review.key };
  const ref = refFromKey(review.key);
  return ref === null ? null : { _tag: "pull-request", ref };
};
const toActivity = (row: typeof ActivityRow.Type): ReviewActivity => ({
  id: row.id,
  attemptId: row.attempt_id,
  at: row.at,
  kind: row.kind,
  text: row.text,
  detail: row.detail,
});
const toFeedEntry = (row: typeof FeedRow.Type): ReviewFeedEntry => ({
  key: row.pr_key,
  accountId: row.account_id,
  status: row.status._tag,
  latestRevision: row.latest_revision,
});

/** A review's agent: what the user picked, or `model` null for the agent's own default. */
export interface StoredAgent {
  readonly instance: AgentInstanceId;
  /** The instance's kind, so a review still names its agent after the instance is removed. */
  readonly provider: AgentProviderKind;
  readonly model: string | null;
  readonly options: AgentSelection["options"];
}
const storedAgentOf = (review: ReviewCore): StoredAgent => ({
  instance: review.instance,
  provider: review.provider,
  model: review.model,
  options: review.modelOptions,
});
/** Who started a review: the user, or auto mode for a review request. */
export type Origin = "user" | "auto" | "outside";
/** What a new review is about: a pull request, through an account, or local changes. */
export type NewSubject =
  | { readonly kind: "pull-request"; readonly key: PullRequestKey; readonly accountId: AccountId }
  | {
      readonly kind: "local";
      readonly key: LocalReviewKey;
      readonly local: LocalSource;
      /** What the first attempt reviews. */
      readonly capture: LocalCapture;
    };

/** One line, trimmed and cut to `max` characters, for what the agent reports. */
const clip = (text: string, max: number) => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

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

/** Change notices for `watch`: which review changed and the activity lines it gained. */
export interface Change {
  readonly key: ReviewKey;
  readonly activity: ReadonlyArray<ReviewActivity>;
}

/** A guide the user asked for (or auto mode started) was accepted, or a stack's batch finished. */
export type ReadyNotice =
  | {
      readonly _tag: "ready";
      readonly review: StoredReview;
      readonly title: string;
      readonly revision: number;
      readonly chapters: number;
    }
  | Extract<ReviewFeedEvent, { _tag: "stack-ready" }>;

/** A notice as the pull request feed sends it; a local review's ready isn't one of its events. */
const feedNotice = (notice: ReadyNotice): ReadonlyArray<ReviewFeedEvent> =>
  notice._tag === "stack-ready"
    ? [notice]
    : notice.review.kind === "pull-request"
      ? [
          {
            _tag: "ready",
            key: notice.review.key,
            accountId: notice.review.accountId,
            title: notice.title,
            revision: notice.revision,
            chapters: notice.chapters,
          },
        ]
      : [];

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

/** Where an attempt's reads point, so a tool's paths can be matched to changed files. */
interface ReadContext {
  readonly worktree: string;
  readonly diffFile: string;
  readonly sections: ReadonlyArray<DiffSection>;
  readonly paths: ReadonlySet<string>;
  /** Line ranges of the numbered diff the agent has seen so far, merged. */
  covered: ReadonlyArray<readonly [number, number]>;
}

/** A tool call still running: the files it is reading and the diff lines it prints. */
interface PendingRead {
  readonly direct: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<string>;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

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
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const repo = yield* RepoCache;
  const agents = yield* Agents;
  const tokens = yield* McpTokens;
  const accounts = yield* GitHubAccounts;
  const api = yield* GitHubApi;
  const guideSettings = yield* GuideSettingsStore;
  const guideConfig = yield* GuideConfigStore;
  const pullRequests = yield* PullRequests;
  const server = yield* HttpServer.HttpServer;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;

  const mcpUrl = `http://${config.host}:${Option.getOrElse(boundPort(server.address), () => config.port)}/mcp`;
  const instructions = yield* fs.readFileString(
    path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "instructions.md"),
  );
  const diffsDir = path.join(config.home, "diffs");
  yield* fs.makeDirectory(diffsDir, { recursive: true });
  /** Names this server run; startup only interrupts attempts other runs left unfinished. */
  const runId = yield* crypto.randomUUIDv4;
  /** Shared with fix turns; a slot covers preparing and writing. */
  const slots = agents.slots;
  const running = new Map<AttemptId, Fiber.Fiber<void>>();
  const phases = new Map<AttemptId, ReviewPhase>();
  const changes = yield* PubSub.unbounded<Change>();
  const notices = yield* PubSub.unbounded<ReadyNotice>();
  /** Each attempt's tool calls still running, by tool call id. */
  const reading = new Map<AttemptId, Map<string, PendingRead>>();
  /** Attempts whose streamed `submit_guide` is still adding chapters (`DraftOutline.growing`). */
  const growing = new Set<AttemptId>();
  const readContexts = new Map<AttemptId, ReadContext>();
  /** Each running attempt's last `submit_guide` input that failed its checks, for `revise_guide`. */
  const rejected = new Map<AttemptId, Guide>();
  /** One guide check at a time per attempt, so a call in flight sees the guide another stored. */
  const checking = makeKeyedGate<AttemptId>(1);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The OS random source failing is not something a review can recover from.
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const publish = (key: ReviewKey, activity: ReadonlyArray<ReviewActivity> = []) =>
    PubSub.publish(changes, { key, activity }).pipe(Effect.asVoid);

  /** A pull request's review. A local review's key passed as a pull request's finds nothing. */
  const findReview = (key: PullRequestKey) =>
    sql`SELECT * FROM reviews WHERE pr_key = ${key} AND local IS NULL`.pipe(
      Effect.flatMap(decodePullRequests),
      Effect.map((rows) => (rows[0] === undefined ? null : toPullRequestReview(rows[0]))),
    );
  /** A local review. A pull request's key passed as a local review's finds nothing. */
  const findLocal = (key: LocalReviewKey) =>
    sql`SELECT * FROM reviews WHERE pr_key = ${key} AND local IS NOT NULL`.pipe(
      Effect.flatMap(decodeLocals),
      Effect.map((rows) => (rows[0] === undefined ? null : toLocalReview(rows[0]))),
    );
  /** The review a new subject would make, looked up among its own kind only. */
  const findSubject = (subject: NewSubject) =>
    subject.kind === "pull-request" ? findReview(subject.key) : findLocal(subject.key);
  /** Every local review, the latest changed first. */
  const locals = sql`SELECT * FROM reviews WHERE local IS NOT NULL ORDER BY updated_at DESC`.pipe(
    Effect.flatMap(decodeLocals),
    Effect.map((rows) => rows.map(toLocalReview)),
  );
  /** The review a key names, among its own kind. */
  const findStored = (key: ReviewKey) => (isLocalReviewKey(key) ? findLocal(key) : findReview(key));
  const findReviewById = (id: ReviewId) =>
    sql`SELECT * FROM reviews WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeReviews),
      Effect.map((rows) => (rows[0] === undefined ? null : toStored(rows[0]))),
    );

  /** Status, latest attempt and every revision: everything but the activity feed. */
  const summaryOf = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const review = yield* findReview(key);
      if (review === null) return { key, review: null, attempt: null, revisions: [] };
      return { key, review: toReview(review), ...(yield* progressOf(review.id)) };
    });

  /** A review's latest attempt, as its progress is shown, and every revision. */
  const progressOf = (reviewId: ReviewId) =>
    Effect.gen(function* () {
      const attempts = yield* sql`
        SELECT id, revision, trigger, phase, head_sha, commits, started_at, finished_at, narration,
          started_by, draft_outline, draft_version FROM review_attempts
        WHERE review_id = ${reviewId} ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.flatMap(decodeAttempts),
      );
      const revisions = yield* sql`
        SELECT r.revision, r.attempt_id, a.trigger, r.head_sha, r.created_at FROM review_revisions r
        JOIN review_attempts a ON a.id = r.attempt_id
        WHERE r.review_id = ${reviewId} ORDER BY r.revision`.pipe(Effect.flatMap(decodeRevisions));
      const attempt = attempts[0];
      const files =
        attempt === undefined
          ? []
          : yield* sql`
            SELECT path, previous_path, status, additions, deletions, read_at, note
            FROM review_attempt_files WHERE attempt_id = ${attempt.id} ORDER BY position`.pipe(
              Effect.flatMap(decodeFiles),
            );
      const inFlight = new Set<string>();
      for (const pending of attempt === undefined ? [] : (reading.get(attempt.id)?.values() ?? []))
        for (const file of [...pending.direct, ...pending.sections]) inFlight.add(file);
      return {
        attempt:
          attempt === undefined
            ? null
            : {
                id: attempt.id,
                revision: attempt.revision,
                trigger: attempt.trigger,
                headSha: attempt.head_sha,
                commits: attempt.commits,
                phase: attempt.phase,
                startedAt: attempt.started_at,
                finishedAt: attempt.finished_at,
                narration: attempt.narration,
                startedBy: attempt.started_by,
                files: files.map((file): AttemptFile => ({
                  path: file.path,
                  previousPath: file.previous_path,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  read:
                    file.read_at !== null ? "read" : inFlight.has(file.path) ? "reading" : "unread",
                  note: file.note,
                })),
                draft:
                  attempt.draft_outline === null
                    ? null
                    : {
                        version: attempt.draft_version,
                        chapters: attempt.draft_outline,
                        growing: growing.has(attempt.id),
                      },
              },
        revisions: revisions.map((row) => ({
          revision: row.revision,
          attemptId: row.attempt_id,
          trigger: row.trigger,
          headSha: row.head_sha,
          createdAt: row.created_at,
        })),
      };
    });

  const snapshotOf = (key: PullRequestKey) =>
    Effect.gen(function* () {
      const summary = yield* summaryOf(key);
      if (summary.review === null || summary.attempt === null) return { ...summary, activity: [] };
      const activity = yield* activityOf(summary.attempt.id);
      return { ...summary, activity } satisfies ReviewSnapshot;
    });

  /** An attempt's last 200 activity lines, oldest first. */
  const activityOf = (attemptId: AttemptId) =>
    sql`
      SELECT id, attempt_id, at, kind, text, detail FROM (
        SELECT * FROM review_activity WHERE attempt_id = ${attemptId} ORDER BY id DESC LIMIT 200
      ) ORDER BY id`.pipe(
      Effect.flatMap(decodeActivity),
      Effect.map((rows) => rows.map(toActivity)),
    );

  /** What a local attempt reviews; null for a pull request's. */
  const captureOf = (attemptId: AttemptId) =>
    sql`SELECT capture FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeCaptures),
      Effect.map((rows) => rows[0]?.capture ?? null),
    );

  const appendActivity = (
    key: ReviewKey,
    reviewId: ReviewId,
    attemptId: AttemptId,
    kind: ReviewActivity["kind"],
    text: string,
    detail: string | null = null,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        INSERT INTO review_activity (review_id, attempt_id, at, kind, text, detail)
        VALUES (${reviewId}, ${attemptId}, ${at}, ${kind}, ${text}, ${detail}) RETURNING id`.pipe(
        Effect.flatMap(decodeInserted),
      );
      const id = rows[0]?.id;
      if (id !== undefined) yield* publish(key, [{ id, attemptId, at, kind, text, detail }]);
    });

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

  const setPhase = (key: ReviewKey, reviewId: ReviewId, attemptId: AttemptId, phase: ReviewPhase) =>
    Effect.gen(function* () {
      if (phases.get(attemptId) === phase) return;
      phases.set(attemptId, phase);
      yield* sql`UPDATE review_attempts SET phase = ${phase} WHERE id = ${attemptId} AND finished_at IS NULL`;
      yield* appendActivity(key, reviewId, attemptId, "phase", phase);
    });

  /**
   * Compare-and-set on the current attempt id: a late result from an older attempt
   * changes nothing. Done is absorbing: only a new attempt leaves it.
   */
  const setStatus = (
    reviewId: ReviewId,
    expected: AttemptId | null,
    status: ReviewStatus,
    current: AttemptId | null,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE reviews SET status = ${encodeStatus(status)}, current_attempt_id = ${current}, updated_at = ${at}
        WHERE id = ${reviewId} AND current_attempt_id IS ${expected}
          AND json_extract(status, '$._tag') != 'done' RETURNING id`;
      return rows.length > 0;
    });

  const insertAttempt = (input: {
    readonly id: AttemptId;
    readonly reviewId: ReviewId;
    readonly revision: number;
    readonly trigger: AttemptTrigger;
    readonly agent: StoredAgent;
    readonly at: string;
    /** The stack batch the attempt was started in, announced with the others. */
    readonly batch: string | null;
    /** What a local attempt reviews; null for a pull request's. */
    readonly capture: LocalCapture | null;
  }) =>
    Effect.gen(function* () {
      const startedBy = yield* StartedBy;
      yield* sql`
        INSERT INTO review_attempts (id, review_id, revision, trigger, run_id, phase, started_at, provider,
          instance_id, model, batch_id, started_by, capture)
        VALUES (${input.id}, ${input.reviewId}, ${input.revision}, ${input.trigger}, ${runId}, 'preparing-code',
          ${input.at}, ${input.agent.provider}, ${input.agent.instance}, ${input.agent.model}, ${input.batch},
          ${startedBy}, ${input.capture === null ? null : encodeCapture(input.capture)})`;
    });

  /** Says in the attempt's activity which outside agent started it, if one did. */
  const noteStartedBy = (key: ReviewKey, reviewId: ReviewId, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const startedBy = yield* StartedBy;
      if (startedBy !== null)
        yield* appendActivity(key, reviewId, attemptId, "note", `Started from ${startedBy}`);
    });

  const batchOf = (attemptId: AttemptId) =>
    sql`SELECT batch_id FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeBatch),
      Effect.map((rows) => rows[0]?.batch_id ?? null),
    );

  /**
   * Announces a stack's batch once none of its attempts is running: one notice for
   * all of them, counted from each review's latest attempt in the batch. Claiming
   * `announced_at` makes a second call, or one after a restart, do nothing.
   */
  const settleBatch = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      const batch = yield* batchOf(attemptId);
      if (batch === null) return;
      const outcomes = yield* sql`
        SELECT a.finished_at, a.outcome FROM review_attempts a
        WHERE a.batch_id = ${batch} AND a.rowid = (
          SELECT MAX(b.rowid) FROM review_attempts b
          WHERE b.batch_id = a.batch_id AND b.review_id = a.review_id)`.pipe(
        Effect.flatMap(decodeOutcomes),
      );
      if (outcomes.some((row) => row.finished_at === null)) return;
      const at = yield* now;
      const claimed = yield* sql`
        UPDATE guide_batches SET announced_at = ${at}
        WHERE id = ${batch} AND announced_at IS NULL RETURNING origin_key, account_id`.pipe(
        Effect.flatMap(decodeClaimed),
      );
      const origin = claimed[0];
      if (origin === undefined) return;
      const ready = outcomes.filter((row) => row.outcome === "accepted").length;
      yield* Effect.logInfo("Stack guides finished").pipe(
        Effect.annotateLogs({ batch, ready, failed: outcomes.length - ready }),
      );
      yield* PubSub.publish(notices, {
        _tag: "stack-ready",
        key: origin.origin_key,
        accountId: origin.account_id,
        ready,
        failed: outcomes.length - ready,
      });
    }).pipe(
      Effect.catchTags({
        SqlError: (error) => Effect.logWarning("Couldn't settle the stack's guides", error),
        SchemaError: (error) => Effect.logWarning("Couldn't settle the stack's guides", error),
      }),
    );

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
      const stored = current?.modelOptions ?? [];
      // Every setting the model takes goes in explicitly, so a resumed session
      // doesn't keep a choice from an earlier attempt.
      const options =
        model === undefined
          ? stored
          : resolveModelOptions(model.options, stored).map((option) => ({
              id: option.descriptor.id,
              value: option.value,
            }));
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
              message: "prkit couldn't save the review. Retry.",
            }),
          ),
        SchemaError: () =>
          Effect.fail(
            new AttemptFailure({
              reason: "agent",
              message: "prkit read a damaged review record. Retry.",
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
                  message: "prkit hit an internal error. Retry.",
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
   * conversation with it.
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
      const usable = yield* usableAgent(agent);
      const attemptId = AttemptId.make(yield* newId);
      const at = yield* now;
      // Another conversation group (another kind or config folder) starts a new conversation.
      const sameGroup = yield* agents.sameGroup(usable.instance);
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
    });

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
        return yield* new ReviewError({ message: "prkit couldn't save the review. Try again." });
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
    });

  const dbFailures = {
    SqlError: () =>
      Effect.fail(
        new ReviewError({ message: "prkit couldn't read or save the review. Try again." }),
      ),
    SchemaError: () =>
      Effect.fail(new ReviewError({ message: "prkit read a damaged review record. Try again." })),
  };

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

  const stop = (key: PullRequestKey) =>
    end(key, "stopped").pipe(Effect.andThen(snapshotOf(key)), Effect.catchTags(dbFailures));

  /** Every review the watcher reads: all pull requests' that are not done. */
  const watched = sql`
    SELECT * FROM reviews WHERE json_extract(status, '$._tag') != 'done' AND local IS NULL`.pipe(
    Effect.flatMap(decodePullRequests),
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

  const guide = (key: ReviewKey, revision: number | undefined) =>
    Effect.gen(function* () {
      const rows = yield* (
        revision === undefined
          ? sql`
            SELECT r.revision, r.head_sha, r.created_at, r.guide, a.snapshot, a.config FROM review_revisions r
            JOIN reviews v ON v.id = r.review_id JOIN review_attempts a ON a.id = r.attempt_id
            WHERE v.pr_key = ${key} ORDER BY r.revision DESC LIMIT 1`
          : sql`
            SELECT r.revision, r.head_sha, r.created_at, r.guide, a.snapshot, a.config FROM review_revisions r
            JOIN reviews v ON v.id = r.review_id JOIN review_attempts a ON a.id = r.attempt_id
            WHERE v.pr_key = ${key} AND r.revision = ${revision}`
      ).pipe(Effect.flatMap(decodeGuides));
      const row = rows[0];
      if (row === undefined)
        return yield* new GuideNotFoundError({
          key,
          message:
            revision === undefined
              ? isLocalReviewKey(key)
                ? "These local changes have no guide yet."
                : "This pull request has no guide yet."
              : `Guide revision ${revision} doesn't exist.`,
        });
      return {
        revision: row.revision,
        headSha: row.head_sha,
        createdAt: row.created_at,
        normalized: row.guide,
        snapshot: row.snapshot,
        config: row.config,
      } satisfies GuideRevision;
    }).pipe(Effect.catchTags(dbFailures));

  /** The attempt a progress tool call speaks for, if it is still the one running. */
  const liveAttempt = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.review_id, r.pr_key, r.current_attempt_id, a.finished_at, a.snapshot, a.draft, a.config
        FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE a.id = ${attemptId}`.pipe(
        Effect.flatMap(decodeSubmit),
      );
      const row = rows[0];
      if (row === undefined || row.current_attempt_id !== attemptId || row.finished_at !== null)
        return yield* new ToolRejected({
          message:
            "This attempt is no longer current, so prkit ignored the call. End your turn now.",
        });
      return row;
    });

  const toolFailures = {
    SqlError: () =>
      Effect.fail(new ToolRejected({ message: "prkit couldn't save that. Call the tool again." })),
    SchemaError: () =>
      Effect.fail(
        new ToolRejected({ message: "prkit couldn't read this attempt. Call the tool again." }),
      ),
  };

  /** `report_progress`: the one line the reviewer sees about what the agent is doing now. */
  const reportProgress = (attemptId: AttemptId, message: string) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      const line = clip(message, 160);
      if (line === "")
        return yield* new ToolRejected({
          message: "Send one short line about what you are doing.",
        });
      yield* sql`UPDATE review_attempts SET narration = ${line} WHERE id = ${attemptId} AND finished_at IS NULL`;
      yield* publish(row.pr_key);
      return { message: "The reviewer sees it. Keep going." } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /** `note_file`: one line about a changed file, shown next to it while the guide is written. */
  const noteFile = (attemptId: AttemptId, filePath: string, note: string) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      const line = clip(note, 240);
      if (line === "")
        return yield* new ToolRejected({
          message: "Send one plain line about what the file changes.",
        });
      const updated = yield* sql`
        UPDATE review_attempt_files SET note = ${line}
        WHERE attempt_id = ${attemptId} AND path = ${filePath} RETURNING path`;
      if (updated.length === 0)
        return yield* new ToolRejected({
          message: `\`${filePath}\` isn't one of this diff's changed files. Use the path exactly as the diff lists it.`,
        });
      yield* publish(row.pr_key);
      return { message: "Noted." } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /** Keeps a checked draft as the attempt's latest, for the reviewer to read now. */
  const keepDraft = (attemptId: AttemptId, draft: DraftGuide, normalized: NormalizedGuide) =>
    Effect.gen(function* () {
      const outline = normalized.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        written: chapter.files.length > 0,
      }));
      yield* sql`
        UPDATE review_attempts SET draft = ${encodeDraft(draft)}, draft_outline = ${encodeOutline(outline)},
          draft_version = draft_version + 1
        WHERE id = ${attemptId} AND finished_at IS NULL`;
      return outline;
    });

  /**
   * `submit_draft`: merges the call into the draft so far and keeps it when every
   * reference resolves. A draft is for reading early; only `submit_guide` makes a revision.
   */
  const submitDraft = (attemptId: AttemptId, input: DraftGuide) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      if (row.snapshot === null || row.config === null)
        return yield* new ToolRejected({ message: "The diff isn't ready yet. Try again shortly." });
      const merged = mergeDraft(row.draft, input);
      const result = normalizeDraft(
        merged,
        reviewedSnapshot(row.snapshot, row.config.skipped),
        checkContextOf(row.config),
      );
      if (result.normalized === null)
        return yield* new ToolRejected({
          message: `The draft has ${plural(result.errors.length, "problem")}. Fix ${result.errors.length === 1 ? "it" : "them"} and send the draft again:\n- ${result.errors.join("\n- ")}`,
        });
      const outline = yield* keepDraft(attemptId, merged, result.normalized);
      yield* setPhase(row.pr_key, row.review_id, attemptId, "writing-guide");
      yield* publish(row.pr_key);
      const written = outline.filter((chapter) => chapter.written).length;
      return {
        message: `Draft saved: the overview${outline.length === 0 ? "" : ` and ${written} of ${plural(outline.length, "chapter")} written`}. Send each chapter with submit_draft as you finish it, then the complete guide with submit_guide.`,
      } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /**
   * One finished piece of a `submit_guide` call the agent is still writing: a field
   * or a chapter. It joins the draft the way a `submit_draft` call would, except that
   * a reference to a chapter not written yet waits instead of failing. A piece that
   * doesn't pass is left out, so the reviewer keeps the last good draft; the call's
   * own check tells the agent what was wrong.
   */
  const streamDraft = (attemptId: AttemptId, piece: DraftGuide) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      if (row.snapshot === null || row.config === null) return;
      const merged = mergeDraft(row.draft, piece);
      const result = normalizeDraft(
        withoutUnwrittenChapters(merged),
        reviewedSnapshot(row.snapshot, row.config.skipped),
        checkContextOf(row.config),
      );
      if (result.normalized === null)
        return yield* Effect.logInfo("Left a streamed guide piece out of the draft").pipe(
          Effect.annotateLogs({ problems: result.errors.join(" | ") }),
        );
      yield* keepDraft(attemptId, merged, result.normalized);
      yield* publish(row.pr_key);
    }).pipe(
      Effect.catchTags({
        ToolRejected: () => Effect.void,
        SqlError: (error) => Effect.logWarning("Couldn't save the streamed draft", error),
        SchemaError: (error) => Effect.logWarning("Couldn't read the attempt's draft", error),
      }),
    );

  /** How many chapters the attempt's draft has, to tell a first `submit_guide` from a resubmission. */
  const draftChapters = (attemptId: AttemptId) =>
    sql`SELECT draft FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeDraftOnly),
      Effect.map((rows) => rows[0]?.draft?.chapters?.length ?? 0),
      Effect.catchTags({
        SqlError: () => Effect.succeed(0),
        SchemaError: () => Effect.succeed(0),
      }),
    );

  /** The latest draft of an attempt, normalized for rendering. */
  const draft = (key: ReviewKey, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.snapshot, a.draft, a.config, a.draft_version FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key}`.pipe(Effect.flatMap(decodeDraft));
      const row = rows[0];
      const normalized =
        row?.draft == null || row.snapshot === null || row.config === null
          ? null
          : normalizeDraft(
              withoutUnwrittenChapters(row.draft),
              reviewedSnapshot(row.snapshot, row.config.skipped),
              checkContextOf(row.config),
            ).normalized;
      if (row === undefined || normalized === null)
        return yield* new GuideNotFoundError({
          key,
          message: "The agent hasn't shared a draft yet.",
        });
      return { attemptId, version: row.draft_version, normalized } satisfies DraftGuideResult;
    }).pipe(Effect.catchTags(dbFailures));

  /** The diff an attempt works on, once its head is fetched. */
  const diff = (key: ReviewKey, attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.snapshot, a.draft, a.config, a.draft_version FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key}`.pipe(Effect.flatMap(decodeDraft));
      const snapshot = rows[0]?.snapshot ?? null;
      if (snapshot === null)
        return yield* new GuideNotFoundError({ key, message: "The code isn't checked out yet." });
      return snapshot;
    }).pipe(Effect.catchTags(dbFailures));

  /** The new side of paths at the commit an attempt read, from prkit's own copy of the repository. */
  const texts = (key: PullRequestKey, attemptId: AttemptId, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.head_sha FROM review_attempts a
        JOIN reviews r ON r.id = a.review_id
        WHERE a.id = ${attemptId} AND r.pr_key = ${key} AND r.local IS NULL`.pipe(
        Effect.flatMap(decodeHeads),
      );
      const headSha = rows[0]?.head_sha ?? null;
      const ref = refFromKey(key);
      if (headSha === null || ref === null)
        return yield* new GuideNotFoundError({ key, message: "The code isn't checked out yet." });
      return yield* repo.readTexts(ref, headSha, paths);
    }).pipe(
      Effect.catchTags({
        ...dbFailures,
        RepoError: (error) => Effect.fail(new ReviewError({ message: error.message })),
      }),
    );

  /**
   * The median click-to-guide time of past full guides by the same agent instance on
   * diffs of a similar size (half to double the changed lines). Null with fewer
   * than two such guides: no estimate prkit can't back up.
   */
  const typicalDuration = (instance: AgentInstanceId, lines: number) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT (julianday(finished_at) - julianday(started_at)) * 86400.0 AS seconds FROM review_attempts
        WHERE outcome = 'accepted' AND instance_id = ${instance}
          AND trigger IN ('first', 'retry', 'rewritten', 'retargeted')
          AND changed_lines BETWEEN ${Math.max(0, Math.floor(lines / 2) - 20)} AND ${lines * 2 + 20}
        ORDER BY rowid DESC LIMIT 15`.pipe(Effect.flatMap(decodeDurations));
      if (rows.length < 2) return null;
      const sorted = rows.map((row) => row.seconds).toSorted((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? (sorted[middle] ?? 0)
          : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
      return { seconds: Math.round(median), samples: rows.length } satisfies TypicalDuration;
    }).pipe(Effect.catchTags(dbFailures));

  const feedEntry = (key: ReviewKey) =>
    sql`
      SELECT pr_key, account_id, status, latest_revision FROM reviews
      WHERE pr_key = ${key} AND local IS NULL`.pipe(
      Effect.flatMap(decodeFeed),
      Effect.map((rows) => rows.map(toFeedEntry)),
    );

  /**
   * Every review's state for the whole app (inbox marks, tabs, notifications):
   * all of them first, then each change of status or revision, and `ready` notices.
   */
  const feed = (): Stream.Stream<ReviewFeedEvent, ReviewError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const changed = yield* PubSub.subscribe(changes);
        const ready = yield* PubSub.subscribe(notices);
        const all =
          yield* sql`SELECT pr_key, account_id, status, latest_revision FROM reviews WHERE local IS NULL`.pipe(
            Effect.flatMap(decodeFeed),
            Effect.map((rows) => rows.map(toFeedEntry)),
          );
        const sent = new Map(all.map((entry) => [entry.key, JSON.stringify(entry)]));
        const updates = Stream.fromSubscription(changed).pipe(
          Stream.mapEffect((change) => feedEntry(change.key).pipe(Effect.catchTags(dbFailures))),
          Stream.flatMap((entries) =>
            Stream.fromIterable(
              entries.flatMap((review): ReadonlyArray<ReviewFeedEvent> => {
                const encoded = JSON.stringify(review);
                if (sent.get(review.key) === encoded) return [];
                sent.set(review.key, encoded);
                return [{ _tag: "changed", review }];
              }),
            ),
          ),
        );
        const opening: ReviewFeedEvent = { _tag: "index", reviews: all };
        return Stream.concat(
          Stream.succeed(opening),
          Stream.merge(
            updates,
            Stream.fromSubscription(ready).pipe(
              Stream.flatMap((notice) => Stream.fromIterable(feedNotice(notice))),
            ),
          ),
        );
      }).pipe(Effect.catchTags(dbFailures)),
    );

  /** Checks a guide against the attempt's snapshot: a valid one is stored, a rejected one kept for `revise_guide`. */
  const checkGuide = (attemptId: AttemptId, input: Guide) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.review_id, r.pr_key, r.current_attempt_id, a.finished_at, a.snapshot, a.draft, a.config, a.guide
        FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE a.id = ${attemptId}`.pipe(
        Effect.flatMap(decodeCheck),
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.current_attempt_id !== attemptId ||
        row.finished_at !== null ||
        row.snapshot === null ||
        row.config === null
      )
        return yield* new SubmitGuideRejected({ message: NO_LONGER_CURRENT });
      // The agent's guide covers the files it reviewed; prkit adds the skipped ones itself.
      const config = row.config;
      const result = normalizeGuide(
        input,
        reviewedSnapshot(row.snapshot, config.skipped),
        checkContextOf(config),
      );
      const warnings =
        result.warnings.length === 0
          ? ""
          : `\n\nWarnings (they don't block the guide):\n- ${result.warnings.join("\n- ")}`;
      const receipt = (normalized: NormalizedGuide): SubmitGuideReceipt => ({
        message: `prkit stored the guide.${warnings}\n\nEnd your turn now.`,
        chapters: normalized.chapters.length,
        files: normalized.chapters.reduce((count, chapter) => count + chapter.files.length, 0),
        warnings: [...result.warnings],
      });
      if (row.guide !== null) {
        // A call sent again because prkit failed after storing it gets its receipt again.
        if (
          result.normalized !== null &&
          encodeGuide(withSkippedChapter(result.normalized, config.skipped)) === row.guide
        )
          return receipt(result.normalized);
        return yield* new SubmitGuideRejected({ message: ALREADY_STORED });
      }
      yield* setPhase(row.pr_key, row.review_id, attemptId, "checking-guide");
      yield* Effect.logInfo("submit_guide validated").pipe(
        Effect.annotateLogs({
          attemptId,
          valid: result.normalized !== null,
          errors: result.errors.length,
          warnings: result.warnings.length,
        }),
      );
      if (result.normalized === null) {
        yield* Effect.logInfo("submit_guide rejected").pipe(
          Effect.annotateLogs({ attemptId, problems: result.errors }),
        );
        yield* appendActivity(
          row.pr_key,
          row.review_id,
          attemptId,
          "error",
          `The guide had ${plural(result.errors.length, "problem")}. The agent is fixing ${result.errors.length === 1 ? "it" : "them"}`,
        );
        yield* setPhase(row.pr_key, row.review_id, attemptId, "writing-guide");
        rejected.set(attemptId, input);
        return yield* new SubmitGuideRejected({
          message: `The guide has ${plural(result.errors.length, "problem")}. Fix all of them: call revise_guide with only the chapters and fields you change, each chapter whole with its id:\n- ${result.errors.join("\n- ")}${warnings}`,
        });
      }
      const normalized = result.normalized;
      const complete = withSkippedChapter(normalized, config.skipped);
      const gaps = coverageProblems(complete, row.snapshot);
      if (gaps.length > 0) {
        yield* Effect.logError("The accepted guide doesn't cover the full diff").pipe(
          Effect.annotateLogs({ attemptId, gaps }),
        );
        return yield* new SubmitGuideRejected({
          message: `prkit couldn't fit the guide to the full diff:\n- ${gaps.join("\n- ")}\nCall submit_guide again.`,
        });
      }
      const saved = yield* sql`
        UPDATE review_attempts SET guide = ${encodeGuide(complete)}
        WHERE id = ${attemptId} AND finished_at IS NULL RETURNING id`;
      if (saved.length === 0) return yield* new SubmitGuideRejected({ message: NO_LONGER_CURRENT });
      rejected.delete(attemptId);
      const shown = receipt(normalized);
      yield* appendActivity(
        row.pr_key,
        row.review_id,
        attemptId,
        "note",
        `The guide passed prkit's checks: ${plural(shown.chapters, "chapter")} cover ${plural(shown.files, "file")}`,
      );
      return shown;
    });

  const guideFailures = {
    SqlError: () =>
      Effect.fail(
        new SubmitGuideRejected({
          message: "prkit couldn't save the guide. Call submit_guide again.",
        }),
      ),
    SchemaError: () =>
      Effect.fail(
        new SubmitGuideRejected({
          message: "prkit couldn't read this attempt. Call submit_guide again.",
        }),
      ),
  };

  /** The `submit_guide` tool. */
  const submitGuide = (attemptId: AttemptId, input: Guide) =>
    checking(attemptId, checkGuide(attemptId, input)).pipe(Effect.catchTags(guideFailures));

  /** The `revise_guide` tool: the attempt's last rejected guide with the call applied, checked again. */
  const reviseGuide = (attemptId: AttemptId, patch: GuidePatch) =>
    checking(
      attemptId,
      Effect.gen(function* () {
        const last = rejected.get(attemptId);
        if (last === undefined)
          return yield* new SubmitGuideRejected({
            message:
              "prkit has no rejected guide from this attempt to revise. Call submit_guide with the whole guide.",
          });
        return yield* checkGuide(attemptId, patchGuide(last, patch));
      }),
    ).pipe(Effect.catchTags(guideFailures));

  /**
   * Startup (docs/internals/architecture.md "Restarts"): attempts an earlier run left
   * unfinished become failed(interrupted) and their reviews start a new attempt;
   * checkouts of done or unknown reviews are removed. A second run changes nothing.
   */
  const reconcile = Effect.gen(function* () {
    const at = yield* now;
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
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE review_attempts SET finished_at = ${at}, outcome = 'failed', error = 'interrupted'
            WHERE id = ${attempt.id} AND finished_at IS NULL`;
          yield* setStatus(
            attempt.review_id,
            attempt.id,
            { _tag: "failed", reason: "interrupted", message, attemptId: attempt.id },
            null,
          );
        }),
      );
      const review = yield* findReviewById(attempt.review_id);
      if (review !== null)
        yield* appendActivity(review.key, review.id, attempt.id, "error", message);
    }
    const interrupted = yield* sql`
      SELECT * FROM reviews WHERE json_extract(status, '$._tag') = 'failed'
        AND json_extract(status, '$.reason') = 'interrupted'`.pipe(Effect.flatMap(decodeReviews));
    for (const row of interrupted) {
      const review = toStored(row);
      const attemptId = review.status._tag === "failed" ? review.status.attemptId : null;
      // A stack's guide picks up where it left off and is still announced with the others.
      const batch = attemptId === null ? null : yield* batchOf(attemptId);
      // Local changes are written again from the snapshot that attempt took, not the folder now.
      const capture =
        review.kind === "local" && attemptId !== null ? yield* captureOf(attemptId) : null;
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
    for (const name of yield* repo.listWorktrees()) {
      if (live.has(name)) continue;
      const reviewId = ReviewId.make(name);
      // The cache to prune comes from prkit's own record of the review, never the checkout.
      const review = yield* findReviewById(reviewId);
      if (yield* repo.removeWorktree(reviewId, review === null ? null : cacheOf(review))) removed++;
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
    const locals = yield* sql`SELECT pr_key FROM reviews WHERE local IS NOT NULL`.pipe(
      Effect.flatMap(decodeLocalKeys),
    );
    yield* repo.local
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
    feed,
    guide,
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
