import * as Schema from "effect/Schema";

import { AgentInstanceId, AgentProviderKind } from "./agentInstance.ts";
import { capture, diffRows } from "./diffRows.ts";
import type { DiffSnapshot } from "./diffSnapshot.ts";
import type { NormalizedGuide } from "./guide.ts";
import { ReviewId } from "./ids.ts";
import { CommentAnchor } from "./reviewComments.ts";

/** One question about a pull request, asked on one revision of its guide. */
export const QuestionId = Schema.NonEmptyString.pipe(Schema.brand("QuestionId"));
export type QuestionId = typeof QuestionId.Type;

const WholePullRequest = Schema.TaggedStruct("pull-request", {});
const WholeLocalChanges = Schema.TaggedStruct("local-changes", {});
const ChapterScope = Schema.TaggedStruct("chapter", { chapterId: Schema.NonEmptyString });
const LinesScope = Schema.TaggedStruct("lines", { anchor: CommentAnchor });

/**
 * What a question is about: the whole subject (a pull request, or a local review's changes),
 * one chapter of the revision's guide, or diff rows of one file, named the way a review comment
 * names them. A whole-subject scope must match its review's subject (`Asks` refuses the other).
 */
export const AskScope = Schema.Union([
  WholePullRequest,
  WholeLocalChanges,
  ChapterScope,
  LinesScope,
]);
export type AskScope = typeof AskScope.Type;
/** The scopes a question about a pull request takes. */
export const PullRequestAskScope = Schema.Union([WholePullRequest, ChapterScope, LinesScope]);
/** The scopes a question about a local review's changes takes. */
export const LocalAskScope = Schema.Union([WholeLocalChanges, ChapterScope, LinesScope]);

export const QUESTION_MAX_LENGTH = 4000;

/** `asks.ask`: a question on one accepted revision of a review. */
export const AskInput = Schema.Struct({
  reviewId: ReviewId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: AskScope,
  text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(QUESTION_MAX_LENGTH)),
});
export type AskInput = typeof AskInput.Type;

/**
 * One piece of an answer, in the order the agent wrote it: its text between two tool calls,
 * or one tool call. The answer itself is every text part, in order.
 */
export const AnswerPart = Schema.Union([
  Schema.TaggedStruct("text", { text: Schema.String }),
  Schema.TaggedStruct("step", { label: Schema.String }),
]);
export type AnswerPart = typeof AnswerPart.Type;

/** The answer to show, copy and pin: every text part in order, a blank line apart. */
export const answerText = (parts: ReadonlyArray<AnswerPart>) =>
  parts
    .flatMap((part) => (part._tag === "text" && part.text.trim() !== "" ? [part.text.trim()] : []))
    .join("\n\n");

/** Why an answer started a new conversation instead of continuing one. */
export const FreshReason = Schema.Literals([
  /** The agent can't fork a conversation (Cursor). */
  "cant-continue",
  /** The guide's conversation went on past this revision, or an update may be adding to it. */
  "moved-on",
  /** The agent answering isn't in the conversation group of the one that wrote the guide. */
  "other-agent",
  /** The agent no longer has the conversation saved. */
  "session-gone",
]);
export type FreshReason = typeof FreshReason.Type;

/** Where an answer's conversation came from. No answer continues a conversation in place. */
export const AnswerBasis = Schema.Union([
  /** A fork of the conversation that wrote this revision's guide. */
  Schema.TaggedStruct("guide-session", {}),
  /** A fork of the answer to an earlier question on the same revision. */
  Schema.TaggedStruct("follow-up", { of: QuestionId }),
  Schema.TaggedStruct("fresh", { why: FreshReason }),
]);
export type AnswerBasis = typeof AnswerBasis.Type;

/** The agent that answers: an instance, and its kind so a removed instance still reads right. */
export const AnswerAgent = Schema.Struct({ instance: AgentInstanceId, kind: AgentProviderKind });
export type AnswerAgent = typeof AnswerAgent.Type;

export const AskFailure = Schema.Literals([
  "agent-auth",
  "agent",
  "repository",
  "interrupted",
  "timeout",
  /** The agent finished without writing anything. */
  "empty",
  /** No agent could take it: the guide's agent is turned off or was removed. */
  "not-ready",
]);
export type AskFailure = typeof AskFailure.Type;

/**
 * A question's lifecycle. Each move is a compare-and-set in `Asks`:
 *   starting  -> waiting | answering | failed | stopped
 *   waiting   -> answering | failed | stopped
 *   answering -> answered | failed | stopped
 *   stopped | failed -> starting   (retry)
 * A restart turns starting, waiting and answering into failed(interrupted). Times are ISO strings.
 */
export const QuestionState = Schema.Union([
  /** Its revision's code and files are being made ready. */
  Schema.TaggedStruct("starting", {}),
  /** For a free agent: prkit runs two at a time, guides and fixes included. */
  Schema.TaggedStruct("waiting", {}),
  Schema.TaggedStruct("answering", { agent: AnswerAgent, basis: AnswerBasis }),
  Schema.TaggedStruct("answered", {
    agent: AnswerAgent,
    basis: AnswerBasis,
    finishedAt: Schema.String,
  }),
  /** Agent and basis are null when it stopped before an agent took it. */
  Schema.TaggedStruct("stopped", {
    agent: Schema.NullOr(AnswerAgent),
    basis: Schema.NullOr(AnswerBasis),
    finishedAt: Schema.String,
  }),
  Schema.TaggedStruct("failed", {
    reason: AskFailure,
    message: Schema.String,
    finishedAt: Schema.String,
  }),
]);
export type QuestionState = typeof QuestionState.Type;

export const Question = Schema.Struct({
  id: QuestionId,
  reviewId: ReviewId,
  revision: Schema.Int,
  scope: AskScope,
  text: Schema.String,
  /** The outside client that asked it, by the name it gave; null when asked in the app. */
  askedBy: Schema.NullOr(Schema.String),
  askedAt: Schema.String,
  state: QuestionState,
  /** The parts so far while it is being answered; what was kept once it stopped, failed or was answered. */
  answer: Schema.Array(AnswerPart),
  /** Only an answered question is pinned. A pin shows on the revision it was asked on. */
  pinnedAt: Schema.NullOr(Schema.String),
});
export type Question = typeof Question.Type;

/**
 * `asks.watch`: one review's questions, then each change. The stream subscribes before it
 * reads, so a `text` event can repeat text the snapshot already has: `at` is where the delta
 * starts in its part, and only what lies past the part's length is new. A `question` event
 * carries the whole row; after a retry its answer is empty again and new parts count from 0.
 * `damaged` names the stored questions prkit couldn't read, which the snapshot leaves out.
 */
export const AskWatchEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    questions: Schema.Array(Question),
    damaged: Schema.Array(QuestionId),
  }),
  Schema.TaggedStruct("question", { question: Question }),
  Schema.TaggedStruct("text", {
    questionId: QuestionId,
    part: Schema.Int,
    at: Schema.Int,
    delta: Schema.String,
  }),
  Schema.TaggedStruct("step", { questionId: QuestionId, part: Schema.Int, label: Schema.String }),
]);
export type AskWatchEvent = typeof AskWatchEvent.Type;

export class AskError extends Schema.TaggedError<AskError>()("AskError", {
  /**
   * not-found: no such revision or question. invalid: the scope isn't part of the revision.
   * not-ready: no agent can answer. state: the question can't do that now. busy: another
   * question on the review is still being answered. failed: prkit couldn't read or save it.
   */
  reason: Schema.Literals(["not-found", "invalid", "not-ready", "state", "busy", "failed"]),
  message: Schema.String,
  /** The question still being answered, on `busy`. */
  active: Schema.optionalKey(QuestionId),
}) {}

type GuideChapter = NormalizedGuide["chapters"][number];

/**
 * The chapter a question is about: its own, or the one holding its lines' file. Null for the
 * whole subject, undefined when the guide has no such chapter.
 */
export const askedChapter = (
  scope: AskScope,
  guide: NormalizedGuide,
): GuideChapter | null | undefined => {
  switch (scope._tag) {
    case "pull-request":
    case "local-changes":
      return null;
    case "chapter":
      return guide.chapters.find((chapter) => chapter.id === scope.chapterId);
    case "lines":
      return guide.chapters.find((chapter) =>
        chapter.files.some((file) => file.path === scope.anchor.path),
      );
  }
};

/**
 * The diff rows a lines scope covers, each `+`, `-` or a space and then the line, or null
 * when the snapshot doesn't show them inside one hunk of a text diff.
 */
export const askedRows = (snapshot: DiffSnapshot, anchor: CommentAnchor, headSha: string) => {
  const file = snapshot.files.find((entry) => entry.path === anchor.path);
  if (file?.patch._tag !== "text") return null;
  return capture(diffRows(file.patch.patch), anchor, headSha)?.snippet ?? null;
};
