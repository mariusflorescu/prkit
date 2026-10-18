import type {
  FailureReason,
  LocalHead,
  LocalLeftOut,
  LocalReviewEntry,
  LocalReviewStatus,
  LocalSource,
} from "@prkit/contracts";

import type { ReviewWords } from "~/components/review/reviewPresentation";

/** "widgets · feature/limits": the folder and the branch, as the tab and the page title say it. */
export const localTitle = (source: Pick<LocalSource, "name" | "branch">) =>
  `${source.name} · ${source.branch ?? "detached HEAD"}`;

export const HEAD_WORDS: Record<LocalHead, string> = {
  "working-tree": "Working tree",
  branch: "Branch tip",
};

export const LEFT_OUT_REASONS: Record<LocalLeftOut["reason"], string> = {
  "too-large": "over 50 MB",
  filtered: "stored through a git filter such as Git LFS",
  "nested-repository": "a repository of its own",
};

/** Nothing watches local changes: a current guide is ready, and a rerun is the user's own. */
export const LOCAL_WORDS: ReviewWords = {
  current: "Ready",
  update: (attempt) =>
    attempt.trigger === "new-commits"
      ? `Changed since revision ${attempt.revision - 1}, writing the update`
      : "Writing the guide again",
  ended: { stopped: "Stopped", merged: "Stopped", closed: "Stopped" },
  revision: (revision) => {
    switch (revision.trigger) {
      case "first":
        return `r${revision.revision} · first guide`;
      case "new-commits":
        return `r${revision.revision} · changed since r${revision.revision - 1}`;
      case "retry":
        return `r${revision.revision} · written again`;
      case "rewritten":
      case "retargeted":
        return `r${revision.revision} · fresh guide`;
    }
  },
};

export const LOCAL_FAILURE_TITLES: Record<FailureReason, string> = {
  account: "prkit couldn't prepare your changes",
  github: "prkit couldn't prepare your changes",
  repository: "prkit couldn't prepare your changes",
  "agent-auth": "Your agent isn't ready",
  agent: "The agent stopped with an error",
  "no-guide": "The agent didn't finish the guide",
  interrupted: "prkit stopped while writing the guide",
  settings: "Your ignore rules skip every changed file",
};

/** One status in a few words, for the tab's tooltip and the palette. */
export const LOCAL_STATUS_WORDS: Record<LocalReviewEntry["status"], string> = {
  preparing: "Preparing",
  writing: "Writing the guide",
  ready: "Guide ready",
  failed: "Guide failed",
  done: "Stopped",
};

export const isRunning = (status: LocalReviewStatus) =>
  status._tag === "preparing" || status._tag === "writing";
