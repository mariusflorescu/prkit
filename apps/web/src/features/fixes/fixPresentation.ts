import type {
  ConflictResolution,
  FixerTurn,
  FixerTurnId,
  FixerTurnState,
  FixStatus,
} from "@prkit/contracts";

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const short = (sha: string) => sha.slice(0, 7);

/** What a turn works on, in a few words. */
export const turnTitle = (turn: FixerTurn) => {
  switch (turn.work._tag) {
    case "fix":
      return `Fix ${plural(turn.work.comments.length, "comment")}`;
    case "conflicts":
      return turn.work.strategy === "merge"
        ? `Merge ${turn.baseRef ?? "the base branch"} into this branch`
        : `Rebase onto ${turn.baseRef ?? "the base branch"}`;
    case "revert":
      return `Revert the merge ${short(turn.work.sha)}`;
  }
};

export const STATUS_LABEL: Record<FixerTurnState, string> = {
  queued: "Queued",
  preparing: "Preparing",
  running: "Working",
  ready: "Ready to review",
  pushing: "Pushing",
  pushed: "Pushed",
  unchanged: "No changes",
  discarded: "Discarded",
  failed: "Failed",
};

export const STATUS_TONE: Record<FixerTurnState, string> = {
  queued: "text-muted-foreground",
  preparing: "text-muted-foreground",
  running: "text-info-foreground",
  ready: "text-warning-foreground",
  pushing: "text-info-foreground",
  pushed: "text-success-foreground",
  unchanged: "text-muted-foreground",
  discarded: "text-muted-foreground",
  failed: "text-error-foreground",
};

export const isWorking = (state: FixerTurnState) =>
  state === "preparing" || state === "running" || state === "pushing";

export const FIX_STATUS_LABEL: Record<FixStatus, string> = {
  fixed: "Fixed",
  partly: "Partly fixed",
  skipped: "Skipped",
};

export const RESOLUTION_LABEL: Record<ConflictResolution, string> = {
  ours: "Kept this branch's side",
  theirs: "Kept the base's side",
  combined: "Combined both",
  "needs-human": "Needs you",
};

export const TRIGGER_NOTE: Record<FixerTurn["trigger"], string | null> = {
  user: null,
  auto: "Started automatically",
  retry: "Retried",
  redo: "Redone after the branch moved",
};

/** Turns that list their scripts: the first, oldest first, to run with each set of commands. */
export const turnsListingScripts = (turns: ReadonlyArray<FixerTurn>) => {
  const seen = new Set<string>();
  const listing = new Set<FixerTurnId>();
  for (const turn of turns.toReversed()) {
    if (turn.scripts?._tag !== "allowed" || turn.scripts.scripts.length === 0) continue;
    const commands = JSON.stringify(turn.scripts.scripts);
    if (!seen.has(commands)) listing.add(turn.id);
    seen.add(commands);
  }
  return listing;
};
