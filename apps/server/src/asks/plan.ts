import type { AgentInstanceId, AnswerBasis, FreshReason, QuestionId } from "@prkit/contracts";

import type { RevisionContext } from "../reviews/Reviews.ts";

/** A conversation an answer may fork, the folder `hasSession` looks for it in, and how the answer names it. */
export interface ForkSource {
  readonly sessionId: string;
  readonly cwd: string;
  readonly basis: Extract<AnswerBasis, { readonly _tag: "guide-session" | "follow-up" }>;
}

/** The newest answered question on the same revision that has a conversation of its own. */
export interface EarlierAnswer {
  readonly id: QuestionId;
  readonly sessionId: string;
  readonly instance: AgentInstanceId;
}

/**
 * The conversations an answer may fork, best first, and why it starts a new one when none of
 * them is still saved. A source is only ever an answered question, whose conversation holds
 * the ones before it, or the guide's own conversation exactly as it was for the revision, and
 * only in the answering agent's conversation group. Nothing is resumed in place.
 */
export const forkSources = (input: {
  readonly canFork: boolean;
  /** The instances whose conversations the answering instance can continue. */
  readonly group: ReadonlySet<AgentInstanceId>;
  readonly writer: RevisionContext["writer"];
  readonly previous: EarlierAnswer | null;
  /** The revision's checkout, the folder every earlier answer on it ran in. */
  readonly checkout: string;
}): { readonly sources: ReadonlyArray<ForkSource>; readonly otherwise: FreshReason } => {
  if (!input.canFork) return { sources: [], otherwise: "cant-continue" };
  const sources: Array<ForkSource> = [];
  if (input.previous !== null && input.group.has(input.previous.instance))
    sources.push({
      sessionId: input.previous.sessionId,
      cwd: input.checkout,
      basis: { _tag: "follow-up", of: input.previous.id },
    });
  const sameAgent = input.group.has(input.writer.instance);
  if (sameAgent && input.writer.session !== null)
    sources.push({
      sessionId: input.writer.session.id,
      cwd: input.writer.session.cwd,
      basis: { _tag: "guide-session" },
    });
  return {
    sources,
    otherwise: !sameAgent
      ? "other-agent"
      : input.writer.session === null
        ? "moved-on"
        : "session-gone",
  };
};
