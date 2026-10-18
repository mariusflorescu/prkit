import type { AnswerPart, AskWatchEvent, QuestionId } from "@prkit/contracts";

/** What the agent adds to its answer: more of its reply, or a tool call. */
export type AnswerPiece =
  | { readonly _tag: "text"; readonly delta: string }
  | { readonly _tag: "tool"; readonly label: string };

/** `parts` with one more piece: text grows the last text part, or starts one after a tool call. */
export const foldAnswer = (
  parts: ReadonlyArray<AnswerPart>,
  piece: AnswerPiece,
): ReadonlyArray<AnswerPart> => {
  if (piece._tag === "tool") return [...parts, { _tag: "step", label: piece.label }];
  const last = parts.at(-1);
  return last?._tag === "text"
    ? [...parts.slice(0, -1), { _tag: "text", text: `${last.text}${piece.delta}` }]
    : [...parts, { _tag: "text", text: piece.delta }];
};

/**
 * The watch events that bring a watcher that was sent `sent` (each part's length so far, a
 * step counting as 1) up to `parts`, and what it then has. Only the last part ever grows.
 */
export const catchUp = (
  questionId: QuestionId,
  parts: ReadonlyArray<AnswerPart>,
  sent: ReadonlyArray<number>,
): { readonly events: ReadonlyArray<AskWatchEvent>; readonly sent: ReadonlyArray<number> } => {
  const events: Array<AskWatchEvent> = [];
  const now = parts.map((part, index) => {
    const before = sent[index] ?? 0;
    if (part._tag === "step") {
      if (before === 0) events.push({ _tag: "step", questionId, part: index, label: part.label });
      return 1;
    }
    if (part.text.length > before)
      events.push({
        _tag: "text",
        questionId,
        part: index,
        at: before,
        delta: part.text.slice(before),
      });
    return part.text.length;
  });
  return { events, sent: now };
};
