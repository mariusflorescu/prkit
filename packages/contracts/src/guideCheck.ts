import type { DiffLineRef } from "./guide.ts";
import type { DiffSnapshot } from "./diffSnapshot.ts";
import type { RiskSignal, SkippedFile } from "./guideConfig.ts";
import { describeRule } from "./guideConfigResolve.ts";

export type Report = { errors: Array<string>; warnings: Array<string> };
/** `draft` skips the checks a guide can only pass once it is finished: coverage and empty chapters. */
export type Mode = "guide" | "draft";
export type Range = readonly [number, number];

/**
 * What one attempt asked for, so the checks that depend on the reviewer's settings
 * run. Without it a guide is checked as the visualize-pr format alone.
 */
export interface GuideCheckContext {
  /** The active focus areas, by the id the agent answers under: exactly one entry each. */
  readonly focusAreas: ReadonlyArray<{
    readonly handle: string;
    readonly label: string;
    readonly question: string;
  }>;
  /** Files the ignore rules skip. They are not in the snapshot the guide is checked against. */
  readonly skipped: ReadonlyArray<SkippedFile>;
  /** What prkit found in the reviewed files. Null when the guide doesn't have to rate `risk`. */
  readonly signals: ReadonlyArray<RiskSignal> | null;
  /** The author's own change needs a pre-flight; null forbids one. */
  readonly preflight: { readonly description: string } | null;
}

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "chapter";
export const chapterKey = (chapter: { readonly id?: string; readonly title: string }) =>
  slugify(chapter.id || chapter.title);
export const asList = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;
const whitespace =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const trimWhitespace = new RegExp(`^[${whitespace}]+|[${whitespace}]+$`, "gu");
const wordSeparator = new RegExp(`[${whitespace}]+`, "u");
export const trim = (text: string) => text.replace(trimWhitespace, "");
export const paragraphs = (value: string | ReadonlyArray<string> | undefined) =>
  asList(value).map(trim).filter(Boolean);
export const words = (text: string) => (trim(text) ? trim(text).split(wordSeparator).length : 0);
export const repr = (text: string) => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  return (
    quote +
    text
      .replace(/\\/g, "\\\\")
      .replaceAll(quote, "\\" + quote)
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    quote
  );
};

export const hunkRanges = (patch: string) => {
  const additions: Array<Range> = [];
  const deletions: Array<Range> = [];
  for (const match of patch.matchAll(/(?:^|\n)@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)) {
    const oldStart = Number(match[1]);
    const oldLength = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newLength = Number(match[4] ?? 1);
    if (oldLength) deletions.push([oldStart, oldStart + oldLength - 1]);
    if (newLength) additions.push([newStart, newStart + newLength - 1]);
  }
  return { additions, deletions };
};

export const listRanges = (ranges: ReadonlyArray<Range>) =>
  ranges.map(([low, high]) => `${low}-${high}`).join(", ") || "none";

export const didYouMean = (path: string, snapshot: DiffSnapshot) => {
  const basename = path.split("/").at(-1);
  const close = snapshot.files.find((candidate) => candidate.path.endsWith("/" + basename));
  return close === undefined ? "" : ` Did you mean ${repr(close.path)}?`;
};

export const resolveChapter = (
  value: string | number | undefined,
  chapterIds: ReadonlyArray<string>,
  where: string,
  report: Report,
) => {
  if (value === undefined || value === "") return null;
  if (typeof value === "number") {
    const id = Number.isInteger(value) && value >= 1 ? chapterIds[value - 1] : undefined;
    if (id !== undefined) return id;
    report.errors.push(
      `${where}: chapter number ${value} is out of range (1-${chapterIds.length}).`,
    );
    return null;
  }
  const id = slugify(value);
  if (chapterIds.includes(id)) return id;
  report.errors.push(
    `${where}: chapter \`${value}\` doesn't exist. Chapter ids: ${chapterIds.join(", ")}.`,
  );
  return null;
};

/**
 * Checks that a reference opens a new-side line inside a hunk. `field` is how the guide
 * names it: `at` can move to another file, while a `line` belongs to a file already chosen,
 * so its fix is to leave it out.
 */
export const checkDiffLine = (
  at: DiffLineRef,
  where: string,
  hint: string,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null,
  report: Report,
  field: "at" | "line" = "at",
) => {
  const { path, line } = at;
  const elsewhere = (advice: string) => (field === "line" ? " Leave `line` out." : ` ${advice}`);
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    const left = context?.skipped.find((candidate) => candidate.path === path);
    report.errors.push(
      left === undefined
        ? `${where}: \`${path}\` is not a file in this PR.${didYouMean(path, snapshot)}`
        : `${where}: \`${path}\` is skipped by the reviewer's ignore rules (${left.reasons.map(describeRule).join(", ")}). Point it at a reviewed file.`,
    );
    return;
  }
  if (line < 1) {
    report.errors.push(
      `${where}: \`${field === "at" ? "at.line" : "line"}\` must be a positive line number, got ${line}.`,
    );
    return;
  }
  if (file.patch._tag !== "text") {
    report.errors.push(
      `${where}: \`${path}\` has a \`${file.patch._tag}\` patch, so \`${field}\` can't point into it.${elsewhere("Point at a line of a text diff.")}`,
    );
    return;
  }
  const ranges = hunkRanges(file.patch.patch);
  if (ranges.additions.length === 0 && ranges.deletions.length === 0) {
    report.errors.push(
      `${where}: \`${path}\` has no diff hunks (a rename only), so \`${field}\` can't point into it.${elsewhere("Point at a file with changed lines.")}`,
    );
    return;
  }
  if (ranges.additions.length === 0) {
    report.errors.push(
      `${where}: \`${path}\` is deleted, so it has no new-side lines.${elsewhere("Point it at a file that still exists, such as the code that used to call it.")}`,
    );
    return;
  }
  if (!ranges.additions.some(([low, high]) => low <= line && line <= high))
    report.errors.push(
      `${where}: \`${path}\` line ${line} is not a new-side line inside the diff hunks, so it can't open. New-side lines: ${listRanges(ranges.additions)}.${hint}`,
    );
};
