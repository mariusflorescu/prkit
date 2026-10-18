import type { PullRequestKey, ReviewId } from "@prkit/contracts";
import { createContext, useContext } from "react";

/**
 * The accepted guide revision on screen, which questions are asked on. Only the Guide tab
 * provides one, so the Files tab's diffs never offer Ask.
 */
export type AskTarget = {
  readonly key: PullRequestKey;
  readonly reviewId: ReviewId;
  readonly revision: number;
  /** Shows a line of a revision's diff, switching to that revision first. */
  readonly openLine: (revision: number, path: string, line: number) => void;
};

export const AskTargetContext = createContext<AskTarget | null>(null);

export const useAskTarget = () => useContext(AskTargetContext);
