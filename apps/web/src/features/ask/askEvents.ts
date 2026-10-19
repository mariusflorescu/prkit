import type { AnswerPart, AskWatchEvent, Question, QuestionId } from "@prkit/contracts";

import type { AsksState } from "~/rpc/queries";

type Parts = ReadonlyArray<AnswerPart>;

const setPart = (parts: Parts, index: number, part: AnswerPart): Parts =>
  index === parts.length ? [...parts, part] : parts.map((old, at) => (at === index ? part : old));

/** Text past what the part already has; the watch can send text the snapshot already held. */
const addText = (parts: Parts, index: number, at: number, delta: string): Parts => {
  const part = parts[index];
  if (part === undefined)
    return index === parts.length ? setPart(parts, index, { _tag: "text", text: delta }) : parts;
  if (part._tag !== "text" || at + delta.length <= part.text.length) return parts;
  return setPart(parts, index, {
    _tag: "text",
    text: part.text + delta.slice(Math.max(0, part.text.length - at)),
  });
};

const editAnswer = (
  state: Extract<AsksState, { _tag: "ready" }>,
  id: QuestionId,
  edit: (parts: Parts) => Parts,
): AsksState => {
  let changed = false;
  const questions = state.questions.map((question) => {
    if (question.id !== id) return question;
    const answer = edit(question.answer);
    if (answer === question.answer) return question;
    changed = true;
    return { ...question, answer };
  });
  return changed ? { ...state, questions } : state;
};

const upsert = (questions: ReadonlyArray<Question>, question: Question) =>
  questions.some((known) => known.id === question.id)
    ? questions.map((known) => (known.id === question.id ? question : known))
    : [...questions, question];

/**
 * One watch event applied to what the client has, safe to replay: a snapshot replaces
 * everything, a question replaces its whole row (so a retried one starts its answer again),
 * text adds only what lies past its part's length, and a step sets its part.
 */
export const applyAskEvent = (state: AsksState, event: AskWatchEvent): AsksState => {
  if (event._tag === "snapshot")
    return { _tag: "ready", questions: event.questions, damaged: event.damaged, problem: null };
  // A subscription always opens with its snapshot, so nothing else comes before one.
  if (state._tag !== "ready") return state;
  switch (event._tag) {
    case "question":
      return { ...state, questions: upsert(state.questions, event.question) };
    case "text":
      return editAnswer(state, event.questionId, (parts) =>
        addText(parts, event.part, event.at, event.delta),
      );
    case "step":
      return editAnswer(state, event.questionId, (parts) =>
        event.part > parts.length
          ? parts
          : setPart(parts, event.part, { _tag: "step", label: event.label }),
      );
  }
};

/** The watch failed: questions already shown stay, marked with why; a first load fails. */
export const asksFailed = (state: AsksState | undefined, message: string): AsksState =>
  state?._tag === "ready" ? { ...state, problem: message } : { _tag: "error", message };

/** Puts a question the server just stored in the list, unless the watch already has it. */
export const asksAdded = (
  state: AsksState | undefined,
  question: Question,
): AsksState | undefined =>
  state?._tag === "ready" && !state.questions.some((known) => known.id === question.id)
    ? { ...state, questions: [...state.questions, question] }
    : state;
