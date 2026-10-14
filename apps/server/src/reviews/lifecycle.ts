import type { ReviewStatus } from "@prkit/contracts";

/** What a user command does from each review state (docs/internals/architecture.md "The review lifecycle"). */
export type CommandOutcome =
  | { readonly _tag: "start" }
  | { readonly _tag: "stop" }
  /** Already where the command would take it; a repeated click changes nothing. */
  | { readonly _tag: "noop" }
  | { readonly _tag: "reject"; readonly message: string };

export type Command = "generate" | "retry" | "stop";
type State = ReviewStatus["_tag"] | "none";

const start = { _tag: "start" } as const;
const stop = { _tag: "stop" } as const;
const noop = { _tag: "noop" } as const;
const reject = (message: string) => ({ _tag: "reject", message }) as const;

const TABLE: Record<Command, Record<State, CommandOutcome>> = {
  generate: {
    none: start,
    failed: start,
    done: start,
    preparing: noop,
    writing: noop,
    watching: start,
  },
  retry: {
    none: reject("There is no guide to retry yet. Generate one first."),
    failed: start,
    done: reject("This review has ended. Generate the guide again instead."),
    preparing: noop,
    writing: noop,
    watching: reject("The guide is up to date, so there is nothing to retry."),
  },
  stop: {
    none: reject("No guide is being written for this pull request."),
    failed: stop,
    done: noop,
    preparing: stop,
    writing: stop,
    watching: stop,
  },
};

export const decide = (command: Command, status: ReviewStatus | null): CommandOutcome =>
  TABLE[command][status === null ? "none" : status._tag];

/** States a user command may start a new attempt from, for the compare-and-set that starts one. */
export const STARTABLE: ReadonlyArray<ReviewStatus["_tag"]> = ["failed", "done", "watching"];

/** What the watcher read for one review's PR (docs/internals/architecture.md "The watcher"). */
export type Observation =
  | {
      readonly _tag: "pull";
      readonly state: "open" | "closed" | "merged";
      readonly headSha: string;
      readonly baseRef: string;
    }
  /** This PR couldn't be read (not found, rate limited, network); the next tick tries again. */
  | { readonly _tag: "unreadable"; readonly message: string }
  /** GitHub refused the account's token, after one re-read. */
  | { readonly _tag: "refused"; readonly message: string };

export type WatchAction =
  | { readonly _tag: "end"; readonly reason: "merged" | "closed" }
  /** A new head or base branch on a watching review: start the next attempt. */
  | { readonly _tag: "update"; readonly headSha: string }
  /** Read fine and nothing to do: note the check and clear any earlier problem. */
  | { readonly _tag: "checked" }
  | { readonly _tag: "problem"; readonly message: string }
  | { readonly _tag: "fail-account"; readonly message: string }
  | { readonly _tag: "none" };

/**
 * Merged or closed ends any review that isn't done, a running attempt included.
 * A new head or base branch (the layer below merged and the PR now targets the
 * trunk) only starts an attempt from `watching`; pushes during an attempt wait for
 * it to end, so they collapse into one. Failed reviews wait for the user.
 */
export const observe = (status: ReviewStatus, observation: Observation): WatchAction => {
  if (status._tag === "done") return { _tag: "none" };
  switch (observation._tag) {
    case "unreadable":
      return { _tag: "problem", message: observation.message };
    case "refused":
      return status._tag === "watching"
        ? { _tag: "fail-account", message: observation.message }
        : { _tag: "problem", message: observation.message };
    case "pull":
      if (observation.state !== "open") return { _tag: "end", reason: observation.state };
      if (
        status._tag === "watching" &&
        (observation.headSha !== status.headSha ||
          (status.baseRef !== undefined && observation.baseRef !== status.baseRef))
      )
        return { _tag: "update", headSha: observation.headSha };
      return { _tag: "checked" };
  }
};
