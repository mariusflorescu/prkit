import type {
  AttemptSummary,
  AttemptTrigger,
  DoneReason,
  FailureReason,
  RevisionSummary,
} from "@prkit/contracts";

export const FAILURE_TITLES: Record<FailureReason, string> = {
  account: "GitHub refused this pull request's account",
  github: "prkit couldn't read this pull request from GitHub",
  repository: "prkit couldn't prepare the code",
  "agent-auth": "Your agent isn't ready",
  agent: "The agent stopped with an error",
  "no-guide": "The agent didn't finish the guide",
  interrupted: "prkit stopped while writing the guide",
  settings: "Your ignore rules skip every changed file",
  damaged: "prkit couldn't read this guide's record",
};

export const shortSha = (sha: string) => sha.slice(0, 7);

export const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** How a revision came to be, for the revision switcher. */
export const TRIGGER_LABELS: Record<AttemptTrigger, string> = {
  first: "first guide",
  "new-commits": "new commits",
  rewritten: "rewritten history",
  retargeted: "new base branch",
  retry: "generated again",
};

export const ENDED_LINES: Record<DoneReason, string> = {
  merged: "PR merged · review closed",
  closed: "PR closed · review closed",
  stopped: "Not watching for new commits",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a running attempt is doing to an existing guide. */
export const updateLine = (attempt: AttemptSummary) => {
  switch (attempt.trigger) {
    case "new-commits":
      return attempt.commits === null
        ? "New commits landed, reading them"
        : `Updating for ${plural(attempt.commits, "new commit")}`;
    case "rewritten":
      return "Rewritten history, writing a fresh guide";
    case "retargeted":
      return "New base branch, writing a fresh guide";
    case "first":
    case "retry":
      return "Writing the guide again";
  }
};

/** How the status line and the revision switcher word a review's state and history. */
export interface ReviewWords {
  /** Nothing is running and the guide is current. */
  readonly current: string;
  /** What a running attempt does to the guide that exists. */
  readonly update: (attempt: AttemptSummary) => string;
  readonly ended: Record<DoneReason, string>;
  /** One accepted revision in the switcher. */
  readonly revision: (revision: RevisionSummary) => string;
}

export const PULL_REQUEST_WORDS: ReviewWords = {
  current: "Watching for new commits",
  update: updateLine,
  ended: ENDED_LINES,
  revision: (revision) =>
    `r${revision.revision} · ${shortSha(revision.headSha)} · ${TRIGGER_LABELS[revision.trigger]}`,
};

/** "just now", "3 min ago", "2 h ago": coarse on purpose, so the text changes rarely. */
export const formatAgo = (milliseconds: number) => {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
};
