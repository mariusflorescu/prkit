import type { FixerTurn, FixerTurnState } from "@prkit/contracts";

/** What a user command does from each turn state (docs/internals/fix-agent.md). */
export type TurnOutcome =
  | { readonly _tag: "start" }
  /** Already where the command would take it; a repeated click changes nothing. */
  | { readonly _tag: "noop" }
  | { readonly _tag: "reject"; readonly message: string };

export type TurnCommand = "push" | "discard" | "revise" | "retry" | "revert";

const start = { _tag: "start" } as const;
const noop = { _tag: "noop" } as const;
const reject = (message: string) => ({ _tag: "reject", message }) as const;

const working = reject("The agent is still working on this. Wait for it, or stop it.");
const over = reject("This is over. Send the comments again to start a new fix.");

const TABLE: Record<TurnCommand, Record<FixerTurnState, TurnOutcome>> = {
  push: {
    queued: working,
    preparing: working,
    running: working,
    ready: start,
    pushing: noop,
    pushed: noop,
    unchanged: reject("The agent changed nothing, so there is nothing to push."),
    discarded: reject("These changes were discarded."),
    failed: reject("The agent didn't finish, so there is nothing to push. Retry it first."),
  },
  discard: {
    queued: start,
    preparing: start,
    running: start,
    ready: start,
    pushing: reject("prkit is pushing these changes. Wait for the push to finish."),
    pushed: reject("These changes are on GitHub already. Revert them there."),
    unchanged: noop,
    discarded: noop,
    failed: noop,
  },
  revise: {
    queued: working,
    preparing: working,
    running: working,
    ready: start,
    pushing: reject("prkit is pushing these changes. Send the comments again instead."),
    pushed: reject("These changes are on GitHub already. Send a new comment instead."),
    unchanged: over,
    discarded: over,
    failed: reject("The agent didn't finish. Retry it instead."),
  },
  retry: {
    queued: working,
    preparing: working,
    running: working,
    ready: reject("The changes are ready. Push or discard them."),
    pushing: reject("prkit is pushing these changes."),
    pushed: reject("These changes are on GitHub already."),
    unchanged: start,
    discarded: reject("These changes were discarded. Send the comments again instead."),
    failed: start,
  },
  revert: {
    queued: working,
    preparing: working,
    running: working,
    ready: reject("This resolution isn't pushed yet. Discard it instead."),
    pushing: reject("prkit is pushing this resolution. Wait for the push to finish."),
    pushed: start,
    unchanged: reject("Nothing was pushed, so there is nothing to revert."),
    discarded: reject("Nothing was pushed, so there is nothing to revert."),
    failed: reject("Nothing was pushed, so there is nothing to revert."),
  },
};

export const decideTurn = (command: TurnCommand, turn: FixerTurn): TurnOutcome => {
  if (command === "revert" && !(turn.work._tag === "conflicts" && turn.work.strategy === "merge"))
    return reject("Only a pushed merge of the base branch can be reverted from prkit.");
  if (command === "retry" && turn.work._tag === "revert" && turn.status._tag === "unchanged")
    return reject("The revert changed nothing.");
  return TABLE[command][turn.status._tag];
};
