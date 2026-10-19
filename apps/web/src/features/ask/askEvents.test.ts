import {
  AgentInstanceId,
  answerText,
  type AskWatchEvent,
  type Question,
  QuestionId,
  ReviewId,
} from "@prkit/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AsksState } from "~/rpc/queries";

import { applyAskEvent } from "./askEvents.ts";

const id = QuestionId.make("q1");
const question = (answer: Question["answer"], state: Question["state"]): Question => ({
  id,
  reviewId: ReviewId.make("r1"),
  revision: 1,
  scope: { _tag: "pull-request" },
  text: "Why three tries?",
  askedBy: null,
  askedAt: "2026-10-18T00:00:00.000Z",
  state,
  answer,
  pinnedAt: null,
});
const answering: Question["state"] = {
  _tag: "answering",
  agent: { instance: AgentInstanceId.make("claude"), kind: "claude" },
  basis: { _tag: "guide-session" },
};
const text = (part: number, at: number, delta: string): AskWatchEvent => ({
  _tag: "text",
  questionId: id,
  part,
  at,
  delta,
});
const shown = (state: AsksState) =>
  state._tag === "ready" ? state.questions.map((entry) => answerText(entry.answer)) : [];
const replay = (events: ReadonlyArray<AskWatchEvent>) =>
  events.reduce(applyAskEvent, { _tag: "loading" } satisfies AsksState);

describe("applyAskEvent", () => {
  it("shows text a snapshot already held once, however often the watch sends it again", () => {
    const state = replay([
      {
        _tag: "snapshot",
        questions: [question([{ _tag: "text", text: "It stops " }], answering)],
        damaged: [],
      },
      text(0, 0, "It stops "),
      text(0, 0, "It stops after three"),
      text(0, 9, "after three tries."),
      text(0, 9, "after three tries."),
      { _tag: "step", questionId: id, part: 1, label: "Read src/retry.ts" },
      { _tag: "step", questionId: id, part: 1, label: "Read src/retry.ts" },
      text(2, 0, "Backoff is linear."),
    ]);
    expect(shown(state)).toEqual(["It stops after three tries.\n\nBackoff is linear."]);
  });

  it("starts the answer again when a retried question comes back empty", () => {
    const state = replay([
      {
        _tag: "snapshot",
        questions: [question([{ _tag: "text", text: "Half an" }], answering)],
        damaged: [],
      },
      { _tag: "question", question: question([], { _tag: "starting" }) },
      text(0, 0, "A new answer."),
    ]);
    expect(shown(state)).toEqual(["A new answer."]);
  });
});
