import type { DiffSnapshot } from "./diffSnapshot.ts";
import { describeRule } from "./guideConfigResolve.ts";
import { type Guide, type NormalizedGuide, type RiskLevel, riskRank } from "./guide.ts";
import {
  type GuideCheckContext,
  type Mode,
  type Report,
  chapterKey,
  checkDiffLine,
  resolveChapter,
  trim,
  words,
} from "./guideCheck.ts";

type Chapter = NormalizedGuide["chapters"][number];
type RawChapter = Pick<Guide["chapters"][number], "id" | "title" | "risk">;

const REASONS_MAX = 3;
const REASON_WORDS_MAX = 25;

const fileList = (chapter: Chapter) =>
  chapter.files.map((file) => `\`${file.path}\``).join(", ") || "none";

const checkReasons = (
  reasons: ReadonlyArray<{ readonly text: string }>,
  level: RiskLevel,
  owner: string,
  place: (index: number) => string,
  mode: Mode,
  report: Report,
) => {
  if (mode === "guide" && reasons.length === 0)
    report.errors.push(
      `${owner} has no reasons. A level always comes with its reasons: say in one sentence what makes it ${level}, and point at the evidence.`,
    );
  if (reasons.length > REASONS_MAX)
    report.warnings.push(
      `${owner} has ${reasons.length} reasons. Keep the ${REASONS_MAX} or fewer that decide the level.`,
    );
  for (const [index, reason] of reasons.entries()) {
    const count = words(reason.text);
    if (count === 0)
      report.errors.push(
        `${place(index)} has no \`text\`. Say in one short sentence what needs, or doesn't need, a careful read.`,
      );
    else if (count > REASON_WORDS_MAX)
      report.warnings.push(
        `${place(index)} is ${count} words. Keep a reason to one short sentence, under ${REASON_WORDS_MAX}.`,
      );
  }
};

const normalizeChapterRisk = (
  raw: RawChapter["risk"],
  chapter: Chapter,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): Chapter["risk"] => {
  if (raw === undefined) return null;
  const reasons = raw.reasons ?? [];
  const place = (index: number) => `chapter \`${chapter.id}\` risk reason ${index + 1}`;
  checkReasons(reasons, raw.level, `chapter \`${chapter.id}\`: \`risk\``, place, mode, report);
  const normalized: Array<NonNullable<Chapter["risk"]>["reasons"][number]> = [];
  for (const [index, reason] of reasons.entries()) {
    const where = place(index);
    if (reason.file === undefined) {
      report.errors.push(
        `${where} has no \`file\`. Set it to the file of this chapter the reason is about: ${fileList(chapter)}.`,
      );
      continue;
    }
    if (!chapter.files.some((file) => file.path === reason.file)) {
      // A chapter left with no files has its own error already; this one would only repeat it.
      if (chapter.files.length > 0)
        report.errors.push(
          `${where}: \`${reason.file}\` is not a file of this chapter. Its files: ${fileList(chapter)}.`,
        );
      continue;
    }
    if (reason.line !== undefined)
      checkDiffLine(
        { path: reason.file, line: reason.line },
        where,
        "",
        snapshot,
        context,
        report,
        "line",
      );
    normalized.push({ text: trim(reason.text), file: reason.file, line: reason.line ?? null });
  }
  return { level: raw.level, reasons: normalized };
};

const normalizePullRequestRisk = (
  raw: Guide["risk"],
  chapters: ReadonlyArray<Chapter>,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): NormalizedGuide["risk"] => {
  if (raw === undefined) return null;
  const reasons = raw.reasons ?? [];
  const chapterIds = chapters.map((chapter) => chapter.id);
  const owners = new Map(
    chapters.flatMap((chapter) => chapter.files.map((file) => [file.path, chapter.id] as const)),
  );
  const place = (index: number) => `\`risk\` reason ${index + 1}`;
  checkReasons(reasons, raw.level, "`risk`", place, mode, report);
  return {
    level: raw.level,
    reasons: reasons.map((reason, index) => {
      const where = place(index);
      if (mode === "guide" && (reason.chapter === undefined || reason.chapter === ""))
        report.errors.push(
          `${where} has no \`chapter\`. Set it to the chapter that explains it, by id or 1-based number.`,
        );
      const chapter = resolveChapter(reason.chapter, chapterIds, where, report);
      if (reason.at !== undefined) {
        checkDiffLine(reason.at, where, "", snapshot, context, report);
        const owner = owners.get(reason.at.path);
        if (chapter !== null && owner !== undefined && owner !== chapter)
          report.errors.push(
            `${where}: \`at\` is in \`${reason.at.path}\`, which is in chapter \`${owner}\`, not \`${chapter}\`. Point at a line of a file in the chapter the reason names.`,
          );
      }
      return { text: trim(reason.text), chapter, at: reason.at ?? null };
    }),
  };
};

const checkLevels = (
  risk: NormalizedGuide["risk"],
  chapters: ReadonlyArray<Chapter>,
  context: GuideCheckContext | null,
  report: Report,
) => {
  const sensitive = new Map(
    (context?.signals ?? []).flatMap((signal) =>
      signal._tag === "sensitive" ? signal.files.map((file) => [file.path, file] as const) : [],
    ),
  );
  for (const chapter of chapters) {
    if (chapter.risk?.level !== "low") continue;
    const match = chapter.files.flatMap((file) => sensitive.get(file.path) ?? [])[0];
    if (match !== undefined)
      report.errors.push(
        `chapter \`${chapter.id}\` is low, but \`${match.path}\` matches ${describeRule(match)}, a path the reviewer always looks closely at. Rate the chapter medium or high and say why.`,
      );
  }
  if (risk === null) return;
  const highest = chapters.reduce<{ readonly id: string; readonly level: RiskLevel } | null>(
    (top, chapter) =>
      chapter.risk !== null && (top === null || riskRank(chapter.risk.level) > riskRank(top.level))
        ? { id: chapter.id, level: chapter.risk.level }
        : top,
    null,
  );
  if (highest !== null && riskRank(risk.level) < riskRank(highest.level))
    report.errors.push(
      `\`risk.level\` is ${risk.level}, but chapter \`${highest.id}\` is ${highest.level}. The pull request needs at least as careful a read as its most careful chapter: raise \`risk.level\` or lower the chapter.`,
    );
  const named = new Set(risk.reasons.map((reason) => reason.chapter));
  for (const chapter of chapters)
    if (chapter.risk?.level === "high" && !named.has(chapter.id))
      report.warnings.push(
        `chapter \`${chapter.id}\` is high, but no \`risk\` reason names it. Give the pull request a reason that points at it, so the reviewer reads it first.`,
      );
};

/**
 * Checks the agent's risk ratings against the chapters they point into and fills each
 * chapter's `risk`. `chapters` are normalized, with their files resolved. The guide must
 * rate risk only when the attempt computed signals; a draft is checked for what it has.
 */
export const normalizeRisk = (input: {
  readonly raw: { readonly risk: Guide["risk"]; readonly chapters: ReadonlyArray<RawChapter> };
  readonly chapters: ReadonlyArray<Chapter>;
  readonly snapshot: DiffSnapshot;
  readonly mode: Mode;
  readonly context: GuideCheckContext | null;
  readonly report: Report;
}): { readonly risk: NormalizedGuide["risk"]; readonly chapters: ReadonlyArray<Chapter> } => {
  const { raw, snapshot, mode, context, report } = input;
  const required = mode === "guide" && context !== null && context.signals !== null;
  const rawRisks = new Map(raw.chapters.map((chapter) => [chapterKey(chapter), chapter.risk]));
  const chapters = input.chapters.map((chapter) => ({
    ...chapter,
    risk: normalizeChapterRisk(rawRisks.get(chapter.id), chapter, snapshot, mode, context, report),
  }));
  const unrated = chapters.filter((chapter) => chapter.risk === null);
  if (required && unrated.length > 0)
    report.errors.push(
      `These chapters have no \`risk\`: ${unrated.map((chapter) => `\`${chapter.id}\``).join(", ")}. Give each one {"level": "low" | "medium" | "high", "reasons": [{"text": "...", "file": "<a file of the chapter>"}]}.`,
    );
  if (required && raw.risk === undefined)
    report.errors.push(
      '`risk` is missing. Rate how carefully the reviewer should read this pull request: {"level": "low" | "medium" | "high", "reasons": [{"text": "...", "chapter": "<chapter id>"}]}.',
    );
  const risk = normalizePullRequestRisk(raw.risk, chapters, snapshot, mode, context, report);
  if (mode === "guide") checkLevels(risk, chapters, context, report);
  return { risk, chapters };
};

/** Every reason the agent wrote, for the checks that read all of the guide's prose. */
export function* riskTexts(guide: NormalizedGuide) {
  for (const reason of guide.risk?.reasons ?? []) yield reason.text;
  for (const chapter of guide.chapters)
    for (const reason of chapter.risk?.reasons ?? []) yield reason.text;
}
