import type { ConflictStrategy, FixComment, TurnScripts } from "@prkit/contracts";

import type { ReviewTarget } from "../reviews/reviewTarget.ts";

const short = (sha: string) => sha.slice(0, 12);
const LISTED_COMMITS = 40;

export interface Commit {
  readonly sha: string;
  readonly subject: string;
}

const scriptsLine = (scripts: TurnScripts) =>
  scripts._tag === "blocked"
    ? `prkit runs none of this pull request's scripts: ${scripts.reason}. Don't run npm, pnpm, yarn or bun; check your change by reading it.`
    : scripts.scripts.length === 0
      ? "This repository has no test, lint or typecheck scripts you can run."
      : `Check scripts you can run: ${scripts.scripts.map(({ name }) => (name === "test" ? "`npm test`" : `\`npm run ${name}\``)).join(", ")} (or the same with pnpm, yarn or bun).`;

const pullLine = (target: ReviewTarget) =>
  `${target.ref.owner}/${target.ref.repo}#${target.ref.number}: ${target.title}`;

const where = (comment: FixComment) => {
  if (comment.lines === null) return `${comment.path} (GitHub marks these lines outdated)`;
  const { start, end, side } = comment.lines;
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
  return `${comment.path}, ${range} (${side === "new" ? "the pull request's side" : "the old side, before the pull request"})`;
};

const commentBlock = (comment: FixComment) =>
  [
    `${comment.id}. ${where(comment)}`,
    ...(comment.snippet.trim() === "" ? [] : ["```diff", comment.snippet.trimEnd(), "```"]),
    comment.body.trim(),
  ].join("\n");

export interface FixPrompt {
  readonly target: ReviewTarget;
  readonly headSha: string;
  readonly comments: ReadonlyArray<FixComment>;
  readonly note: string | null;
  readonly scripts: TurnScripts;
  /** Why this batch runs again: the branch moved before the last result was pushed. */
  readonly redo: boolean;
  /** The session already worked on this PR, so the checkout may differ from what it remembers. */
  readonly resumed: boolean;
}

/** A batch of review comments for the agent. Pure: structured input in, prompt out. */
export const fixPrompt = (input: FixPrompt) => {
  const { target } = input;
  const opening = input.redo
    ? `The branch moved to ${short(input.headSha)} before your fixes were pushed, so prkit dropped them and checked out the new head. Make the same fixes again on top of it.`
    : `Fix the review comments below on pull request ${pullLine(target)}.`;
  return [
    opening,
    "",
    ...(input.resumed && !input.redo
      ? [
          `prkit reset the checkout to the branch as GitHub has it now, ${short(input.headSha)}. It has only what was pushed, so look before you assume an earlier change is there.`,
          "",
        ]
      : []),
    `The working directory is the pull request's branch \`${target.headRef}\` at ${short(input.headSha)}, which merges into \`${target.baseRef}\`.`,
    scriptsLine(input.scripts),
    "",
    `Comments (${input.comments.length}):`,
    "",
    input.comments.map(commentBlock).join("\n\n"),
    ...(input.note === null ? [] : ["", "The owner also says:", input.note]),
    "",
    `When every comment is handled, call \`finish_fixes\` with the commit message and one entry for each of ${input.comments.map((comment) => comment.id).join(", ")}, then end your turn.`,
  ].join("\n");
};

export interface ConflictPrompt {
  readonly target: ReviewTarget;
  readonly strategy: ConflictStrategy;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  /** Files the agent resolves. */
  readonly files: ReadonlyArray<string>;
  /** Files prkit keeps on the base side for the owner. */
  readonly held: ReadonlyArray<string>;
  readonly ours: ReadonlyArray<Commit>;
  readonly theirs: ReadonlyArray<Commit>;
  readonly scripts: TurnScripts;
  /** The latest guide's overview, as a file the agent can read, when there is one. */
  readonly guideFile: string | null;
  /** For a rebase: the PR commit whose replay stopped. */
  readonly replaying: Commit | null;
  readonly redo: boolean;
}

const commitList = (commits: ReadonlyArray<Commit>) => {
  const listed = commits.slice(-LISTED_COMMITS);
  return [
    ...(commits.length > listed.length
      ? [`- (${commits.length - listed.length} earlier commits not listed)`]
      : []),
    ...listed.map((commit) => `- ${short(commit.sha)} ${commit.subject}`),
    ...(commits.length === 0 ? ["- (none)"] : []),
  ];
};

/** A conflict resolution for the agent: what git did, both sides' history, and the PR's intent. */
export const conflictPrompt = (input: ConflictPrompt) => {
  const { target } = input;
  const merge = input.strategy === "merge";
  const sides = merge
    ? "Between `<<<<<<<` and `=======` is the pull request's side, between `=======` and `>>>>>>>` the base branch's side."
    : "During a rebase git swaps the sides: between `<<<<<<<` and `=======` is the base branch with the pull request's earlier commits replayed, between `=======` and `>>>>>>>` the change of the commit being replayed.";
  const what = merge
    ? `prkit merged the base branch \`${target.baseRef}\` (${short(input.baseSha)}) into the pull request's branch \`${target.headRef}\` (${short(input.headSha)}) in the working directory.`
    : `prkit is rebasing the pull request's commits onto \`${target.baseRef}\` (${short(input.baseSha)}). Replaying ${input.replaying === null ? "a commit" : `commit ${short(input.replaying.sha)} "${input.replaying.subject}"`} stopped with conflicts.`;
  return [
    input.redo
      ? `The branch moved to ${short(input.headSha)} before your resolution was pushed, so prkit dropped it and started again on the new head.`
      : `Resolve the merge conflicts on pull request ${pullLine(target)}.`,
    "",
    what,
    `These files have conflicts for you to resolve. ${sides}`,
    ...input.files.map((file) => `- ${file}`),
    ...(input.held.length === 0
      ? []
      : [
          "",
          "prkit keeps the base branch's side of these and leaves them for the owner (lockfiles need an install, binary and deleted files need a person). Don't edit them:",
          ...input.held.map((file) => `- ${file}`),
        ]),
    "",
    `What each side changed since they split at ${short(input.mergeBaseSha)}:`,
    "The pull request:",
    ...commitList(input.ours),
    `The base branch \`${target.baseRef}\`:`,
    ...commitList(input.theirs),
    "",
    "The pull request's description:",
    target.body.trim() === "" ? "(empty)" : target.body.trim(),
    ...(input.guideFile === null
      ? []
      : [
          "",
          "prkit's guide to the pull request explains what it is for. Read it when a conflict turns on intent:",
          input.guideFile,
        ]),
    "",
    scriptsLine(input.scripts),
    "",
    `Resolve each file so both sides' intent survives. To see one side, use \`git diff ${short(input.mergeBaseSha)} ${short(merge ? input.headSha : (input.replaying?.sha ?? input.headSha))} -- <path>\` (the pull request) or \`git diff ${short(input.mergeBaseSha)} ${short(input.baseSha)} -- <path>\` (the base). Remove every conflict marker. Then call \`finish_conflicts\` with one entry for each file you were asked to resolve, and end your turn.`,
  ].join("\n");
};

/** The next commit of a rebase stopped too, in the same session. */
export const nextStopPrompt = (input: {
  readonly replaying: Commit;
  readonly files: ReadonlyArray<string>;
  readonly held: ReadonlyArray<string>;
}) =>
  [
    `prkit replayed your resolution. The next commit, ${short(input.replaying.sha)} "${input.replaying.subject}", conflicts too, in:`,
    ...input.files.map((file) => `- ${file}`),
    ...(input.held.length === 0
      ? []
      : [
          "prkit keeps the base side of these for the owner:",
          ...input.held.map((file) => `- ${file}`),
        ]),
    "",
    "Resolve them the same way, then call `finish_conflicts` with one entry for each file and end your turn.",
  ].join("\n");

/** The owner read the result and wants something changed, in the same session. */
export const revisePrompt = (input: {
  readonly note: string;
  readonly sha: string;
  readonly kind: "fix" | "conflicts";
  readonly ids: ReadonlyArray<string>;
}) =>
  [
    "The owner reviewed your changes and asks:",
    input.note,
    "",
    `The checkout still has your changes (prkit's commit ${short(input.sha)}). Change them as asked and run the checks again if they cover what you touched.`,
    input.kind === "fix"
      ? `Then call \`finish_fixes\` again with the complete report, one entry for each of ${input.ids.join(", ")}, and end your turn.`
      : "Then call `finish_conflicts` again with one entry for every file you resolved, and end your turn.",
  ].join("\n");

/** One nudge when a turn ends without the report it owes. */
export const nudgePrompt = (kind: "fix" | "conflicts") =>
  kind === "fix"
    ? "You ended your turn without calling `finish_fixes`, so prkit has no report. Call it now with one entry per comment, then end your turn."
    : "You ended your turn without a `finish_conflicts` report prkit could accept. Remove any conflict markers left, call it with one entry per file, then end your turn.";
