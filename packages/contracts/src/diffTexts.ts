import * as Schema from "effect/Schema";

import { FixerTurnId } from "./fixer.ts";
import { AccountId, PullRequestKey } from "./ids.ts";
import { AttemptId } from "./review.ts";

/**
 * The commit a diff's new side was read at, named by the diff's owner, so the server reads
 * that exact commit the way the owner may: a pull request's head through the account that
 * found it, a guide attempt's head and a fix turn's commit from prkit's local repository cache.
 */
export const DiffSource = Schema.Union([
  Schema.TaggedStruct("pullRequest", {
    key: PullRequestKey,
    accountId: AccountId,
    sha: Schema.String,
  }),
  Schema.TaggedStruct("attempt", { key: PullRequestKey, attemptId: AttemptId }),
  Schema.TaggedStruct("fixerTurn", {
    key: PullRequestKey,
    turnId: FixerTurnId,
    sha: Schema.String,
  }),
]);
export type DiffSource = typeof DiffSource.Type;

/** How many paths one read takes: one GitHub request each, or one `git cat-file` run. */
export const DIFF_TEXT_BATCH = 50;
/** A file longer than this reads as too large, as expanding unchanged lines already says. */
export const DIFF_TEXT_MAX_BYTES = 1_000_000;

export const FileText = Schema.Union([
  Schema.TaggedStruct("text", { content: Schema.String }),
  Schema.TaggedStruct("unreadable", {
    reason: Schema.Literals(["binary", "too-large", "missing"]),
  }),
]);
export type FileText = typeof FileText.Type;

/** The new side of each asked path, in the order asked. */
export const DiffTexts = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, text: FileText })),
});
export type DiffTexts = typeof DiffTexts.Type;

export class DiffTextsError extends Schema.TaggedError<DiffTextsError>()("DiffTextsError", {
  message: Schema.String,
}) {}
