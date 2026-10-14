import * as Schema from "effect/Schema";

import { PullRequestState } from "./github.ts";
import { PullRequestKey } from "./ids.ts";

/**
 * Where a PR sits in a GitHub stack, where each PR builds on the one below it.
 * Position 1 is the bottom layer, the one on the trunk.
 */
export const StackMembership = Schema.Struct({
  number: Schema.Int,
  size: Schema.Int,
  position: Schema.Int,
  /** The branch the bottom layer merges into. */
  base: Schema.String,
});
export type StackMembership = typeof StackMembership.Type;

export const StackLayer = Schema.Struct({
  position: Schema.Int,
  number: Schema.Int,
  title: Schema.String,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  headBranch: Schema.String,
  baseBranch: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type StackLayer = typeof StackLayer.Type;

export const PullRequestStack = Schema.Struct({
  number: Schema.Int,
  base: Schema.String,
  /** Bottom to top. */
  layers: Schema.Array(StackLayer),
});
export type PullRequestStack = typeof PullRequestStack.Type;

/** Why a guide for the stack left a layer out. */
export const StackSkipReason = Schema.Literals(["has-guide", "running", "not-open"]);
export type StackSkipReason = typeof StackSkipReason.Type;

/** What a guide for several layers started: bottom to top. */
export const StackGuidesResult = Schema.Struct({
  started: Schema.Array(PullRequestKey),
  skipped: Schema.Array(Schema.Struct({ key: PullRequestKey, reason: StackSkipReason })),
});
export type StackGuidesResult = typeof StackGuidesResult.Type;
