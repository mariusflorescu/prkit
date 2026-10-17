import * as Schema from "effect/Schema";

/**
 * What a run reviews on top of the base: the working tree (staged, unstaged and untracked
 * changes included) or the committed branch tip alone.
 */
export const LocalHead = Schema.Literals(["working-tree", "branch"]);
export type LocalHead = typeof LocalHead.Type;

/** What a review of local changes is about, and the base and head its last run asked for. */
export const LocalSource = Schema.Struct({
  /** The work tree's folder name. */
  name: Schema.String,
  /** The work tree's top-level folder. */
  path: Schema.String,
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  /** Null when the run looked for the base itself. */
  base: Schema.NullOr(Schema.String),
  head: LocalHead,
});
export type LocalSource = typeof LocalSource.Type;
