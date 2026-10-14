import type { FixTarget, PendingComment, ReviewThread } from "@prkit/contracts";

import { rangeLabel } from "~/features/reviewComments/reviewCommentPresentation";

/** One comment the user may hand to the agent: a prkit draft, or an open GitHub thread. */
export interface FixCandidate {
  readonly id: string;
  readonly target: FixTarget;
  readonly kind: "draft" | "thread";
  readonly label: string;
  readonly where: string;
  readonly excerpt: string;
  /** A thread whose last comment is someone else's: it waits for an answer. */
  readonly awaitsReply: boolean;
}

const excerpt = (body: string) => {
  const line = body.replaceAll(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

export const candidateId = (target: FixTarget) =>
  target._tag === "draft" ? `draft:${target.id}` : `thread:${target.threadId}`;

/** Drafts first, then unresolved threads, each once. */
export const fixCandidates = (
  drafts: ReadonlyArray<PendingComment>,
  threads: ReadonlyArray<ReviewThread>,
  login: string,
): ReadonlyArray<FixCandidate> => [
  ...drafts
    .filter((draft) => draft.state === "draft")
    .map((draft): FixCandidate => {
      const target: FixTarget = { _tag: "draft", id: draft.id };
      return {
        id: candidateId(target),
        target,
        kind: "draft",
        label: "Your draft",
        where: `${draft.anchor.path} ${rangeLabel(draft.anchor)}`,
        excerpt: excerpt(draft.body),
        awaitsReply: false,
      };
    }),
  ...threads
    .filter((thread) => !thread.resolved)
    .map((thread): FixCandidate => {
      const target: FixTarget = { _tag: "thread", threadId: thread.id };
      return {
        id: candidateId(target),
        target,
        kind: "thread",
        label: `Thread by ${thread.comments[0]?.author?.login ?? "ghost"}`,
        where: `${thread.path} ${thread.anchor === null ? "(outdated)" : rangeLabel(thread.anchor)}`,
        excerpt: excerpt(thread.comments.at(-1)?.body ?? ""),
        awaitsReply: thread.comments.at(-1)?.author?.login !== login,
      };
    }),
];
