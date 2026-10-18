import type {
  AnswerBasis,
  AnswerPart,
  AskScope,
  CommentAnchor,
  FreshReason,
  NormalizedGuide,
  Question,
} from "@prkit/contracts";

export const WHOLE_PR: AskScope = { _tag: "pull-request" };

export const BUSY = "Wait for this answer or stop it to ask another.";

export const isActive = (question: Question) =>
  question.state._tag === "starting" ||
  question.state._tag === "waiting" ||
  question.state._tag === "answering";

const FRESH: Record<FreshReason, string> = {
  "cant-continue": "New session: Cursor can't continue the guide's session",
  "moved-on": "New session: the guide's conversation may have gone on past this revision",
  "other-agent": "New session: another agent answered",
  "session-gone": "New session: the agent no longer has the guide's session",
};

/** Where the answer's conversation came from, in words. */
export const basisWords = (basis: AnswerBasis) =>
  basis._tag === "guide-session"
    ? "From the session that wrote this guide"
    : basis._tag === "follow-up"
      ? "Continues your earlier question"
      : FRESH[basis.why];

/**
 * What a question is doing, for its status line and the dock's announcements. While it
 * answers, `step` is the tool call it made last, if that is the newest part.
 */
export const stateWords = (question: Question, { step }: { step: boolean }) => {
  switch (question.state._tag) {
    case "starting":
      return `Getting revision ${question.revision}'s code ready`;
    case "waiting":
      return "Waiting for a free agent. prkit runs two at a time and both are busy.";
    case "answering": {
      const last = question.answer.at(-1);
      return step && last?._tag === "step" ? last.label : "Answering";
    }
    case "answered":
      return "Answered";
    case "stopped":
      return "Stopped";
    case "failed":
      return question.state.message;
  }
};

/**
 * An answer as it reads: each text part, and each run of tool calls as one line. `start` is
 * the part it begins at, which never changes, since an answer only grows at its end.
 */
export type AnswerBlock =
  | { readonly _tag: "text"; readonly start: number; readonly text: string }
  | { readonly _tag: "steps"; readonly start: number; readonly labels: ReadonlyArray<string> };

export const answerBlocks = (parts: ReadonlyArray<AnswerPart>) => {
  const blocks: Array<AnswerBlock> = [];
  for (const [start, part] of parts.entries()) {
    const last = blocks.at(-1);
    if (part._tag === "text") {
      if (part.text.trim() !== "") blocks.push({ _tag: "text", start, text: part.text });
    } else if (last?._tag === "steps")
      blocks[blocks.length - 1] = { ...last, labels: [...last.labels, part.label] };
    else blocks.push({ _tag: "steps", start, labels: [part.label] });
  }
  return blocks;
};

const rowsLabel = ({ start, end }: CommentAnchor) =>
  `${start.side === "old" ? "old " : ""}${start.line === end.line ? start.line : `${start.line}-${end.line}`}`;

/** "Whole PR", "Chapter 2: Retry policy" or "src/retry.ts 12-18". */
export const scopeLabel = (scope: AskScope, guide: NormalizedGuide | undefined) => {
  switch (scope._tag) {
    case "pull-request":
      return "Whole PR";
    case "chapter": {
      const index = guide?.chapters.findIndex((chapter) => chapter.id === scope.chapterId) ?? -1;
      const chapter = guide?.chapters[index];
      return chapter === undefined ? "Chapter" : `Chapter ${index + 1}: ${chapter.title}`;
    }
    case "lines":
      return `${scope.anchor.path} ${rowsLabel(scope.anchor)}`;
  }
};

export const PLACEHOLDERS: Record<AskScope["_tag"], string> = {
  "pull-request": "Ask about this pull request",
  chapter: "Ask about this chapter",
  lines: "Ask about these lines",
};

/** "Asked on r2", "Asked on r4, newer", or null on the revision it was asked on. */
export const askedOn = (asked: number, shown: number) =>
  asked === shown ? null : asked > shown ? `Asked on r${asked}, newer` : `Asked on r${asked}`;
