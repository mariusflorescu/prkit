import {
  type AnswerBasis,
  askedChapter,
  askedRows,
  type AskScope,
  type DiffSnapshot,
  type LinePoint,
  type NormalizedGuide,
} from "@prkit/contracts";

/** Every question's prompt starts with it, so the stand-in Claude (`scripts/fake-claude.ts`) knows one. */
export const ASK_MARKER = "<prkit-ask>";
/** How many earlier answers a new conversation is told about, and how much of each. */
export const EARLIER_ANSWERS = 4;
const EARLIER_ANSWER_LENGTH = 2000;
const MAX_ROWS = 200;

export interface AskPromptInput {
  /** "acme/widgets#12". */
  readonly label: string;
  readonly revision: number;
  readonly headSha: string;
  readonly guide: NormalizedGuide;
  /** The diff the guide explains. */
  readonly snapshot: DiffSnapshot;
  readonly cwd: string;
  readonly diffFile: string;
  readonly guideFile: string;
  readonly basis: AnswerBasis;
  readonly scope: AskScope;
  readonly question: string;
  /** For a new conversation, the latest answered questions on the revision, oldest first. */
  readonly earlier: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
}

const point = (at: LinePoint) => `${at.side} line ${at.line}`;
const span = (start: LinePoint, end: LinePoint) => {
  if (start.side !== end.side) return `${point(start)} to ${point(end)}`;
  return start.line === end.line ? point(start) : `${start.side} lines ${start.line}-${end.line}`;
};
/** A code fence longer than any run of backticks in `text`, so the text can't close it. */
const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

const workspace = (input: AskPromptInput) => {
  switch (input.basis._tag) {
    case "guide-session":
      return `Earlier in this conversation you wrote the guide the reviewer is reading. Your working directory is now ${input.cwd}, a read-only checkout of the same head, so each file you read before is at the same path relative to it. The numbered diff you read is now ${input.diffFile}, and the guide as the reviewer sees it is ${input.guideFile}.`;
    case "follow-up":
      return `Earlier in this conversation you answered the reviewer's questions about this revision. Your working directory is ${input.cwd}, a read-only checkout of its head. The numbered diff the guide explains is ${input.diffFile}, and the guide is ${input.guideFile}.`;
    case "fresh":
      return `Your working directory is ${input.cwd}, a read-only checkout of the pull request at that head. The guide the reviewer is reading is ${input.guideFile}: read it first. The numbered diff it explains is ${input.diffFile}: read the parts the question needs.`;
  }
};

const about = (input: AskPromptInput): ReadonlyArray<string> => {
  switch (input.scope._tag) {
    case "pull-request":
      return ["The question is about the whole pull request."];
    case "chapter": {
      const chapter = askedChapter(input.scope, input.guide);
      return [
        `The question is about the guide's chapter "${chapter?.title ?? input.scope.chapterId}" (\`${input.scope.chapterId}\`), which covers:`,
        ...(chapter?.files ?? []).map((file) => `- ${file.path}`),
      ];
    }
    case "lines": {
      const { anchor } = input.scope;
      const chapter = askedChapter(input.scope, input.guide);
      const rows = (askedRows(input.snapshot, anchor, input.headSha) ?? "").split("\n");
      const shown = rows.slice(0, MAX_ROWS).join("\n");
      const fence = fenceFor(shown);
      return [
        `The question is about these lines of \`${anchor.path}\` (${span(anchor.start, anchor.end)})${chapter == null ? "" : `, in the guide's chapter "${chapter.title}"`}:`,
        `${fence}diff`,
        shown,
        fence,
        ...(rows.length > MAX_ROWS
          ? [`The selection goes on for ${rows.length - MAX_ROWS} more lines in the diff.`]
          : []),
      ];
    }
  }
};

const cut = (text: string) =>
  text.length > EARLIER_ANSWER_LENGTH ? `${text.slice(0, EARLIER_ANSWER_LENGTH)}…` : text;

/** One question's prompt. The rules for answering are the turn's instructions (`ask-instructions.md`). */
export const askPrompt = (input: AskPromptInput) =>
  [
    ASK_MARKER,
    `A reviewer reading prkit's guide to ${input.label}, revision ${input.revision} at ${input.headSha.slice(0, 7)}, asks you a question.`,
    "",
    workspace(input),
    "",
    ...about(input),
    ...(input.earlier.length === 0
      ? []
      : [
          "",
          "The reviewer asked about this revision before. Their questions and the answers they got:",
          ...input.earlier.flatMap((entry) => [
            "",
            `Question: ${entry.question}`,
            `Answer: ${cut(entry.answer)}`,
          ]),
        ]),
    "",
    "The reviewer's question:",
    input.question,
  ].join("\n");
