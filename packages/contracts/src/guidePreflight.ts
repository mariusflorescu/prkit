import type { DiffSnapshot } from "./diffSnapshot.ts";
import { describeRule } from "./guideConfigResolve.ts";
import type { DiffLineRef, Guide, NormalizedGuide, NormalizedPreflight } from "./guide.ts";
import type { AccountId } from "./ids.ts";
import type { GuideRevision } from "./review.ts";
import { isChangedSource } from "./riskSignals.ts";
import {
  type GuideCheckContext,
  type Report,
  checkDiffLine,
  didYouMean,
  repr,
  resolveChapter,
  trim,
  words,
} from "./guideCheck.ts";

type RawPreflight = NonNullable<Guide["preflight"]>;
type RawClaim = NonNullable<RawPreflight["description"]>[number];
type RawTest = NonNullable<RawPreflight["tests"]>[number];
type Chapter = NormalizedGuide["chapters"][number];
type Claim = NormalizedPreflight["description"][number];
type Place = { readonly chapter: string; readonly at: DiffLineRef | null };

const ITEMS_MAX = 4;
/** Chapters of these kinds hold nothing a missing test would cover, whatever the file is. */
const UNTESTED_KINDS: ReadonlySet<Chapter["kind"]> = new Set([
  "tests",
  "docs",
  "generated",
  "config",
]);
/** Code that configures a tool (`vite.config.ts`, `.eslintrc.js`), not code a test covers. */
const TOOL_CONFIG = /(^|\/)(\.[^/]+rc|[^/]+\.config)\.[a-z]+$/iu;
const WORDS_MAX = 50;
const QUOTE_MAX = 200;

/** A quote matches the description whatever its case and spacing. */
const loose = (text: string) => trim(text).replace(/\s+/gu, " ").toLowerCase();

const checkText = (raw: string, where: string, report: Report) => {
  const text = trim(raw);
  if (!text) report.errors.push(`${where} has no \`text\`. Say the point in a sentence or two.`);
  else if (words(text) > WORDS_MAX)
    report.warnings.push(
      `${where} is ${words(text)} words. Keep a pre-flight point under ${WORDS_MAX}: the author reads all of them.`,
    );
  return text;
};

const checkCount = (count: number, list: string, which: string, report: Report) => {
  if (count > ITEMS_MAX)
    report.errors.push(
      `\`preflight.${list}\` has ${count} items. Keep the ${ITEMS_MAX} ${which} and drop the rest.`,
    );
};

/**
 * The chapter a point is about, and its line when it has one. A line alone is enough:
 * its file's chapter is the point's chapter.
 */
const placeOf = (
  raw: { readonly chapter?: string | number; readonly at?: DiffLineRef },
  where: string,
  chapters: ReadonlyArray<Chapter>,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null,
  report: Report,
): Place | null => {
  if ((raw.chapter === undefined || raw.chapter === "") && raw.at === undefined) {
    report.errors.push(
      `${where} points at nothing. Set \`chapter\` to the chapter it is about, and \`at\` to the line when it is about one line.`,
    );
    return null;
  }
  const named = resolveChapter(
    raw.chapter,
    chapters.map((chapter) => chapter.id),
    where,
    report,
  );
  if (raw.at === undefined) return named === null ? null : { chapter: named, at: null };
  const at = raw.at;
  checkDiffLine(at, where, "", snapshot, context, report);
  const owner = chapters.find((chapter) => chapter.files.some((file) => file.path === at.path));
  if (named !== null && owner !== undefined && owner.id !== named)
    report.errors.push(
      `${where}: \`${at.path}\` is in chapter \`${owner.id}\`, not \`${named}\`. Set \`chapter\` to \`${owner.id}\`, or leave it out.`,
    );
  const chapter = named ?? owner?.id ?? null;
  return chapter === null ? null : { chapter, at };
};

const checkQuote = (
  raw: string | undefined,
  where: string,
  description: string | null,
  report: Report,
) => {
  const quote = trim(raw ?? "");
  if (!quote) {
    report.errors.push(
      `${where} has no \`quote\`. Copy the few words of the description that make the claim.`,
    );
    return quote;
  }
  const length = Array.from(quote).length;
  if (length > QUOTE_MAX)
    report.errors.push(
      `${where}: \`quote\` is ${length} characters. Quote only the words that make the claim, under ${QUOTE_MAX}.`,
    );
  if (description !== null && !loose(description).includes(loose(quote)))
    report.errors.push(
      `${where}: ${repr(quote)} is not in the description. Copy the description's own words, exactly as the prompt quotes them.`,
    );
  return quote;
};

const normalizeClaim = (
  raw: RawClaim,
  where: string,
  description: string | null,
  chapters: ReadonlyArray<Chapter>,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null,
  report: Report,
): Claim | null => {
  const text = checkText(raw.text, where, report);
  if (raw.kind === "missing-from-description") {
    if (raw.quote !== undefined)
      report.errors.push(
        `${where} is \`missing-from-description\`, so the description has no words to quote. Leave \`quote\` out.`,
      );
    const place = placeOf(raw, where, chapters, snapshot, context, report);
    return place === null ? null : { kind: raw.kind, text, ...place };
  }
  const quote = checkQuote(raw.quote, where, description, report);
  if (raw.kind === "missing-from-code") {
    if (raw.chapter !== undefined || raw.at !== undefined)
      report.errors.push(
        `${where} is \`missing-from-code\`: nothing in the diff does it, so leave \`chapter\` and \`at\` out. If the code does it another way, use \`differs\` and point at that code.`,
      );
    return { kind: raw.kind, text, quote };
  }
  const place = placeOf(raw, where, chapters, snapshot, context, report);
  return place === null ? null : { kind: raw.kind, text, quote, ...place };
};

const normalizeTest = (
  raw: RawTest,
  where: string,
  chapters: ReadonlyArray<Chapter>,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null,
  report: Report,
): NormalizedPreflight["tests"][number] | null => {
  const text = checkText(raw.text, where, report);
  const path = raw.path;
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    const left = context?.skipped.find((candidate) => candidate.path === path);
    report.errors.push(
      left === undefined
        ? `${where}: \`${path}\` is not a file in this PR.${didYouMean(path, snapshot)}`
        : `${where}: \`${path}\` is skipped by the reviewer's ignore rules (${left.reasons.map(describeRule).join(", ")}). Point at a reviewed file.`,
    );
    return null;
  }
  if (file.status === "removed") {
    report.errors.push(`${where}: \`${path}\` is deleted, so no test needs to cover it.`);
    return null;
  }
  const owner = chapters.find((chapter) => chapter.files.some((entry) => entry.path === path));
  if (
    !isChangedSource(file) ||
    TOOL_CONFIG.test(path) ||
    (owner !== undefined && UNTESTED_KINDS.has(owner.kind))
  )
    report.errors.push(
      `${where}: \`${path}\` isn't changed source code: it is a test, config, docs, generated code or a rename. Point at the changed code that no test covers.`,
    );
  else if (raw.line !== undefined)
    checkDiffLine({ path, line: raw.line }, where, "", snapshot, context, report, "line");
  return { text, path, line: raw.line ?? null };
};

const present = <T>(item: T | null): item is T => item !== null;

/**
 * Checks the author's pre-flight. With an attempt's context it is required on the
 * author's own pull request and refused on anyone else's, and every quote must be the
 * description's own words. Without one it is checked only against the diff.
 */
export const normalizePreflight = (input: {
  readonly raw: Guide["preflight"];
  readonly chapters: ReadonlyArray<Chapter>;
  readonly snapshot: DiffSnapshot;
  readonly context: GuideCheckContext | null;
  readonly report: Report;
}): NormalizedPreflight | null => {
  const { raw, chapters, snapshot, context, report } = input;
  const asked = context === null ? undefined : context.preflight;
  if (asked === null) {
    if (raw !== undefined)
      report.errors.push(
        "`preflight` is only for the author's own pull request, and the account reading this one didn't open it. Leave `preflight` out.",
      );
    return null;
  }
  if (raw === undefined) {
    if (asked !== undefined)
      report.errors.push(
        'The account reading this guide opened the pull request, so the guide needs `preflight`: what a reviewer will probably ask, where the description and the code disagree, and tests that look missing. If nothing stands out, send `"preflight": {}`.',
      );
    return null;
  }
  const description = asked?.description ?? null;
  const questions = raw.questions ?? [];
  const claims = raw.description ?? [];
  const tests = raw.tests ?? [];
  checkCount(questions.length, "questions", "a reviewer is most likely to raise", report);
  checkCount(claims.length, "description", "that matter most", report);
  checkCount(tests.length, "tests", "that matter most", report);
  const noDescription = description !== null && trim(description) === "" && claims.length > 0;
  if (noDescription)
    report.errors.push(
      "The pull request has no description, so there is nothing to compare. Leave `preflight.description` out: prkit offers to write one from the guide.",
    );
  const seen = new Set<string>();
  for (const [index, test] of tests.entries()) {
    if (seen.has(test.path))
      report.errors.push(
        `preflight test ${index + 1}: \`${test.path}\` is already listed. Give each file one entry and say everything it misses there.`,
      );
    seen.add(test.path);
  }
  return {
    questions: questions
      .map((question, index) => {
        const where = `preflight question ${index + 1}`;
        const text = checkText(question.text, where, report);
        const place = placeOf(question, where, chapters, snapshot, context, report);
        return place === null ? null : { text, chapter: place.chapter, at: place.at };
      })
      .filter(present),
    description: noDescription
      ? []
      : claims
          .map((claim, index) =>
            normalizeClaim(
              claim,
              `preflight description ${index + 1}`,
              description,
              chapters,
              snapshot,
              context,
              report,
            ),
          )
          .filter(present),
    tests: tests
      .map((test, index) =>
        normalizeTest(test, `preflight test ${index + 1}`, chapters, snapshot, context, report),
      )
      .filter(present),
  };
};

/** The pre-flight's own words, for the checks every guide text gets. Quotes are the author's. */
export function* preflightTexts(preflight: NormalizedPreflight | null) {
  if (preflight === null) return;
  for (const item of preflight.questions) yield item.text;
  for (const item of preflight.description) yield item.text;
  for (const item of preflight.tests) yield item.text;
}

/**
 * A revision as one account reads it. The pre-flight, and the description it was checked
 * against, are only for the review's own account: a pre-flight exists only when that account
 * opened the pull request, so every other reader gets the guide without one.
 */
export const forReader = (
  revision: GuideRevision,
  review: AccountId,
  reader: AccountId,
): GuideRevision =>
  reader === review
    ? revision
    : {
        ...revision,
        normalized: { ...revision.normalized, preflight: null },
        config: { ...revision.config, preflight: null },
      };
