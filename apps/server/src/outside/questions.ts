import { answerText, type AnswerBasis, AskScope, type Question } from "@prkit/contracts";
import * as Schema from "effect/Schema";

import type { OutsideQuestion } from "./schemas.ts";

/** The states in which a question is still being answered. */
export const ACTIVE = new Set(["starting", "waiting", "answering"]);

const encodeScope = Schema.encodeSync(Schema.fromJsonString(AskScope));

/** What names an ask for `idempotent`: the revision asked, what it is about, and the words. */
export const askFingerprint = (revision: number | undefined, scope: AskScope, text: string) =>
  [revision ?? null, encodeScope(scope), text] as const;

const FRESH_REASONS = {
  "cant-continue": "this agent can't continue the guide's conversation",
  "moved-on": "the guide's conversation may have gone on past this revision",
  "other-agent": "the guide was written by a different agent",
  "session-gone": "the agent no longer has the guide's conversation",
} as const;

/** Where an answer's conversation came from, as the app says it. */
const basisWords = (basis: AnswerBasis) => {
  switch (basis._tag) {
    case "guide-session":
      return "A fork of the conversation that wrote this guide.";
    case "follow-up":
      return `A fork of the answer to question ${basis.of}.`;
    case "fresh":
      return `A new conversation, since ${FRESH_REASONS[basis.why]}.`;
  }
};

/** A question as outside agents read it, whatever it is about: a pull request or local changes. */
export const outsideQuestion = (question: Question): OutsideQuestion => {
  const { state } = question;
  return {
    id: question.id,
    revision: question.revision,
    scope: question.scope,
    text: question.text,
    askedBy: question.askedBy,
    askedAt: question.askedAt,
    state: state._tag,
    basis:
      (state._tag === "answering" || state._tag === "answered" || state._tag === "stopped") &&
      state.basis !== null
        ? basisWords(state.basis)
        : null,
    message: state._tag === "failed" ? state.message : null,
    answer: answerText(question.answer),
    pinned: question.pinnedAt !== null,
  };
};
