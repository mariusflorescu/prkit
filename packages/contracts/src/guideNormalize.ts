import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

import type { DiffFile, DiffSnapshot } from "./diffSnapshot.ts";
import type { AttemptConfig, SkippedFile } from "./guideConfig.ts";
import { describeRule } from "./guideConfigResolve.ts";
import { globTokens, matchesGlob } from "./guideGlob.ts";
import {
  type DraftGuide,
  type Guide,
  type GuidePatch,
  GuideKind,
  GuideSide,
  GuideTone,
  type NormalizedGuide,
} from "./guide.ts";
import {
  type GuideCheckContext,
  type Mode,
  type Report,
  asList,
  chapterKey,
  didYouMean,
  hunkRanges,
  listRanges,
  paragraphs,
  repr,
  resolveChapter,
  slugify,
  trim,
  words,
} from "./guideCheck.ts";
import { checkFlowLengths, flowTexts, normalizeFlow } from "./guideFlow.ts";
import { manualCheckTexts, normalizeManualCheck } from "./guideManualCheck.ts";
import { normalizeRisk, riskTexts } from "./guideRisk.ts";
import { normalizePreflight, preflightTexts } from "./guidePreflight.ts";

export type { GuideCheckContext };

type RawChapter = DraftChapter | Guide["chapters"][number];
type DraftChapter = NonNullable<DraftGuide["chapters"]>[number];
type Chapter = NormalizedGuide["chapters"][number];
type FileEntry = Exclude<Guide["chapters"][number]["files"][number], string>;

export const checkContextOf = (config: AttemptConfig): GuideCheckContext => ({
  focusAreas: config.focusAreas.flatMap((area) =>
    area.handle === null
      ? []
      : [{ handle: area.handle, label: area.label, question: area.question }],
  ),
  skipped: config.skipped,
  signals: config.signals,
  preflight: config.preflight,
  manualCheck: config.manualCheck,
});

/** The chapter prkit appends for skipped files; an agent's chapter can't take its id. */
export const SKIPPED_CHAPTER_ID = "skipped-by-your-ignore-rules";
const GUIDANCE_NOTE_MAX = 300;

const isKind = Schema.is(GuideKind);
const isTone = Schema.is(GuideTone);
const sideAliases = new Map<string, typeof GuideSide.Type>([
  ["additions", "additions"],
  ["new", "additions"],
  ["right", "additions"],
  ["+", "additions"],
  ["deletions", "deletions"],
  ["old", "deletions"],
  ["left", "deletions"],
  ["-", "deletions"],
]);

const normalizeEntry = (
  entry: FileEntry,
  file: DiffFile,
  report: Report,
): Chapter["files"][number] => {
  const path = file.path;
  const ranges = hunkRanges(file.patch._tag === "text" ? file.patch.patch : "");
  const annotations: Array<Chapter["files"][number]["annotations"][number]> = [];
  for (const annotation of entry.annotations ?? []) {
    const side = sideAliases.get((annotation.side ?? "additions").toLowerCase());
    const line = annotation.line;
    const text = trim(annotation.text);
    if (side === undefined) {
      report.errors.push(
        `\`${path}\`: annotation side \`${annotation.side}\` must be \`additions\` (new lines) or \`deletions\` (old lines).`,
      );
      continue;
    }
    if (!Number.isInteger(line) || line < 1) {
      report.errors.push(`\`${path}\`: annotation needs a positive integer \`line\`, got ${line}.`);
      continue;
    }
    if (!text) {
      report.errors.push(`\`${path}\` line ${line}: annotation has no \`text\`.`);
      continue;
    }
    if (file.patch._tag !== "text") {
      report.errors.push(
        `\`${path}\`: ${side} line ${line} cannot have a note because the patch is \`${file.patch._tag}\`. Line notes need a text patch with diff hunks.`,
      );
      continue;
    }
    if (ranges.additions.length === 0 && ranges.deletions.length === 0) {
      report.errors.push(
        `\`${path}\`: ${side} line ${line} cannot have a note because the text patch has no diff hunks. Rename-only files cannot have line notes.`,
      );
      continue;
    }
    if (!ranges[side].some(([low, high]) => low <= line && line <= high)) {
      report.errors.push(
        `\`${path}\`: ${side} line ${line} is outside the diff hunks, so the note would be hidden. Visible ${side} lines: ${listRanges(ranges[side])}.`,
      );
      continue;
    }
    const tone = annotation.tone ?? "note";
    if (!isTone(tone)) {
      report.errors.push(
        `\`${path}\` line ${line}: annotation tone \`${tone}\` must be one of ${GuideTone.literals.join(", ")}.`,
      );
      continue;
    }
    annotations.push({ line, side, tone, text });
  }
  return {
    path,
    note: entry.note === undefined ? null : trim(entry.note) || null,
    collapsed: entry.collapsed ?? false,
    annotations,
  };
};

const normalizeChapters = (
  rawChapters: ReadonlyArray<RawChapter>,
  snapshot: DiffSnapshot,
  report: Report,
  mode: Mode,
  context: GuideCheckContext | null,
): Array<Chapter> => {
  const skipped = new Map(context?.skipped.map((file) => [file.path, file]));
  if (rawChapters.length === 0 && mode === "guide") {
    report.errors.push("`chapters` must be a non-empty list.");
    return [];
  }
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const owner = new Map<string, string>();
  const seenIds = new Set<string>();
  const chapters: Array<Chapter & { files: Array<Chapter["files"][number]> }> = [];
  const globs: Array<{ chapter: (typeof chapters)[number]; pattern: string; entry: FileEntry }> =
    [];
  for (const [index, raw] of rawChapters.entries()) {
    if (!raw.title) {
      report.errors.push(`chapter ${index + 1}: needs at least a \`title\`.`);
      continue;
    }
    const id = slugify(raw.id || raw.title);
    if (context !== null && id === SKIPPED_CHAPTER_ID)
      report.errors.push(
        `chapter ${index + 1} (${repr(raw.title)}): id \`${id}\` is prkit's own chapter for skipped files. Give your chapter another \`id\`.`,
      );
    if (seenIds.has(id))
      report.errors.push(
        `chapter ${index + 1} (${repr(raw.title)}): id \`${id}\` is used twice - give it a unique \`id\`.`,
      );
    seenIds.add(id);
    let kind = raw.kind ?? "supporting";
    if (!isKind(kind)) {
      report.errors.push(
        `chapter \`${id}\`: kind \`${kind}\` must be one of ${GuideKind.literals.join(", ")}.`,
      );
      kind = "supporting";
    }
    const body = [...asList(raw.body)];
    if (body.length === 0)
      report.warnings.push(
        `chapter \`${id}\` has no \`body\` - say in plain words what this group of files does.`,
      );
    const callouts = (raw.callouts ?? []).map((callout) => {
      let tone = callout.tone ?? "note";
      if (!isTone(tone)) {
        report.errors.push(
          `chapter \`${id}\`: callout tone \`${tone}\` must be one of ${GuideTone.literals.join(", ")}.`,
        );
        tone = "note";
      }
      return { tone, text: callout.text };
    });
    const chapter: (typeof chapters)[number] = {
      id,
      title: raw.title,
      kind,
      body,
      pseudocode: raw.pseudocode || null,
      callouts,
      files: [],
      risk: null,
    };
    chapters.push(chapter);
    for (const rawEntry of raw.files ?? []) {
      const entry = typeof rawEntry === "string" ? { path: rawEntry } : rawEntry;
      const path = entry.path;
      if (/[*?[]/u.test(path)) {
        globs.push({ chapter, pattern: path, entry });
        continue;
      }
      const file = filesByPath.get(path);
      const left = skipped.get(path);
      if (file === undefined && left !== undefined) {
        report.errors.push(
          `chapter \`${id}\`: \`${path}\` is skipped by the reviewer's ignore rules (${left.reasons.map(describeRule).join(", ")}). Leave it out; prkit lists skipped files in a chapter of its own.`,
        );
        continue;
      }
      if (file === undefined) {
        report.errors.push(
          `chapter \`${id}\`: \`${path}\` is not a file in this PR.${didYouMean(path, snapshot)}`,
        );
        continue;
      }
      const previousOwner = owner.get(path);
      if (previousOwner !== undefined) {
        report.errors.push(
          `\`${path}\` is in both \`${previousOwner}\` and \`${id}\` - each file belongs to exactly one chapter.`,
        );
        continue;
      }
      owner.set(path, id);
      chapter.files.push(normalizeEntry(entry, file, report));
    }
  }
  for (const { chapter, pattern, entry } of globs) {
    const tokens = globTokens(pattern);
    const matched = snapshot.files.filter(
      (file) => !owner.has(file.path) && matchesGlob(file.path, tokens),
    );
    if (matched.length === 0)
      report.warnings.push(
        `chapter \`${chapter.id}\`: pattern \`${pattern}\` matched no unassigned files.`,
      );
    for (const file of matched) {
      owner.set(file.path, chapter.id);
      chapter.files.push(
        normalizeEntry({ ...entry, path: file.path, annotations: [] }, file, report),
      );
    }
  }
  if (mode === "draft") return chapters;
  const missing = snapshot.files.filter((file) => !owner.has(file.path));
  if (missing.length)
    report.errors.push(
      `${missing.length} file(s) are not in any chapter. Put each one where it fits, or add a glob like \`"**/*.test.ts"\` to a tests chapter:\n${missing.map((file) => "    " + file.path).join("\n")}`,
    );
  for (const chapter of chapters) {
    if (chapter.files.length === 0)
      report.errors.push(`chapter \`${chapter.id}\` ended up with no files.`);
  }
  const firstCore = chapters.findIndex((chapter) => chapter.kind === "core");
  if (firstCore === -1)
    report.warnings.push(
      "no chapter has kind `core` - mark the chapter(s) carrying the main change as core.",
    );
  else if (
    chapters
      .slice(0, firstCore)
      .some((chapter) => ["tests", "generated", "docs", "config"].includes(chapter.kind))
  )
    report.warnings.push(
      "a tests/config/docs/generated chapter comes before the first core chapter - lead with the core change.",
    );
  return chapters;
};

const checkLengths = (guide: NormalizedGuide, report: Report) => {
  for (const chapter of guide.chapters) {
    for (const callout of chapter.callouts) {
      const count = words(callout.text);
      if (count > 60)
        report.warnings.push(
          `chapter \`${chapter.id}\` has a ${count}-word callout - say it in two sentences.`,
        );
    }
    for (const file of chapter.files) {
      for (const annotation of file.annotations) {
        const count = words(annotation.text);
        if (count > 45)
          report.warnings.push(
            `\`${file.path}\` line ${annotation.line}: note is ${count} words - line notes read best under 45.`,
          );
      }
    }
  }
  checkFlowLengths(guide.flow, report);
};

function* guideTexts(guide: NormalizedGuide) {
  yield* guide.summary;
  yield* guide.background;
  yield* guide.steps;
  for (const chapter of guide.chapters) {
    yield chapter.title;
    yield* chapter.body;
    yield chapter.pseudocode ?? "";
    for (const callout of chapter.callouts) yield callout.text;
    for (const file of chapter.files) {
      yield file.note ?? "";
      for (const annotation of file.annotations) yield annotation.text;
    }
  }
  yield* riskTexts(guide);
  if (guide.flow !== null) yield* flowTexts(guide.flow);
  for (const item of guide.focus) yield item.text;
  for (const area of guide.focusAreas) yield area.text;
  yield guide.guidanceNote ?? "";
  yield* preflightTexts(guide.preflight);
  yield* manualCheckTexts(guide.manualCheck);
}

const checkDashes = (guide: NormalizedGuide, report: Report) => {
  let count = 0;
  for (const text of guideTexts(guide)) count += text.match(/[\u2013\u2014]/gu)?.length ?? 0;
  if (count)
    report.warnings.push(`the guide has ${count} em/en dash(es) - use a plain '-' instead.`);
};

type Normalized = {
  normalized: NormalizedGuide | null;
  errors: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
};

const normalizeFocusAreas = (
  raw: Guide["focusAreas"],
  chapterIds: ReadonlyArray<string>,
  context: GuideCheckContext | null,
  report: Report,
): NormalizedGuide["focusAreas"] => {
  const entries = raw ?? [];
  const asked = context?.focusAreas ?? null;
  const answered = new Set<string>();
  const normalized: Array<NormalizedGuide["focusAreas"][number]> = [];
  for (const entry of entries) {
    const where = `focus area \`${entry.id}\``;
    const area =
      asked === null
        ? { handle: entry.id, label: entry.id, question: "" }
        : asked.find((candidate) => candidate.handle === entry.id);
    if (area === undefined) {
      report.errors.push(
        asked === null || asked.length === 0
          ? `${where}: the reviewer asked for no focus areas, so leave \`focusAreas\` out.`
          : `${where} isn't one of the reviewer's focus areas. Their ids: ${asked.map((candidate) => candidate.handle).join(", ")}.`,
      );
      continue;
    }
    if (answered.has(entry.id)) {
      report.errors.push(`${where} has more than one entry. Give each focus area exactly one.`);
      continue;
    }
    answered.add(entry.id);
    const text = trim(entry.text ?? "");
    const chapter = resolveChapter(entry.chapter, chapterIds, where, report);
    if (entry.verdict === "notable" && entry.chapter === undefined)
      report.errors.push(
        `${where} is notable, so set \`chapter\` to the chapter that explains what the reviewer should look at.`,
      );
    if (entry.verdict !== "nothing-notable" && text === "")
      report.errors.push(
        entry.verdict === "notable"
          ? `${where} is notable but has no \`text\`. Say in one or two sentences what is notable.`
          : `${where} is not assessed but has no \`text\`. Say why, for example "docs-only PR, no migrations touched".`,
      );
    normalized.push({
      id: entry.id,
      label: area.label,
      question: area.question,
      verdict: entry.verdict,
      text,
      chapter,
    });
  }
  for (const area of asked ?? [])
    if (!answered.has(area.handle))
      report.errors.push(
        `\`focusAreas\` has no entry for \`${area.handle}\` (${area.label}: ${area.question}). Add {"id": "${area.handle}", "verdict": "notable" | "nothing-notable" | "not-assessed", "text": "...", "chapter": "<chapter id when notable>"}.`,
      );
  return normalized;
};

const normalizeGuidanceNote = (raw: string | undefined, report: Report) => {
  const note = trim(raw ?? "");
  if (Array.from(note).length > GUIDANCE_NOTE_MAX)
    report.errors.push(
      `\`guidanceNote\` is ${Array.from(note).length} characters. Keep it to one sentence under ${GUIDANCE_NOTE_MAX}.`,
    );
  return note === "" ? null : note;
};

const normalize = (
  guide: DraftGuide & Pick<Guide, "focusAreas" | "guidanceNote" | "preflight">,
  guide: DraftGuide & Pick<Guide, "focusAreas" | "guidanceNote" | "manualCheck">,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
): Normalized => {
  const report: Report = { errors: [], warnings: [] };
  const summary = paragraphs(guide.summary);
  if (summary.length === 0)
    report.errors.push(
      "`summary` is required - explain what this PR does so someone new to the code knows what they're looking at.",
    );
  const { risk, chapters } = normalizeRisk({
    raw: { risk: guide.risk, chapters: guide.chapters ?? [] },
    chapters: normalizeChapters(guide.chapters ?? [], snapshot, report, mode, context),
    snapshot,
    mode,
    context,
    report,
  });
  const chapterIds = chapters.map((chapter) => chapter.id);
  const focus = (guide.focus ?? []).map((item) => {
    let tone = item.tone ?? "note";
    if (!isTone(tone)) {
      report.errors.push(
        `focus item tone \`${tone}\` must be one of ${GuideTone.literals.join(", ")}.`,
      );
      tone = "note";
    }
    return {
      tone,
      text: item.text,
      chapter: resolveChapter(item.chapter, chapterIds, "focus item", report),
    };
  });
  const normalized: NormalizedGuide = {
    summary,
    background: paragraphs(guide.background),
    steps: [...asList(guide.steps)],
    chapters,
    risk,
    signals: context?.signals ?? [],
    flow: normalizeFlow(guide.flow, chapterIds, snapshot, mode, context, report),
    focus,
    focusAreas:
      mode === "draft" ? [] : normalizeFocusAreas(guide.focusAreas, chapterIds, context, report),
    guidanceNote: mode === "draft" ? null : normalizeGuidanceNote(guide.guidanceNote, report),
    preflight:
      mode === "draft"
        ? null
        : normalizePreflight({ raw: guide.preflight, chapters, snapshot, context, report }),
    manualCheck:
      mode === "draft"
        ? null
        : normalizeManualCheck({
            raw: guide.manualCheck,
            chapterIds,
            required: context?.manualCheck === true,
            report,
          }),
  };
  checkLengths(normalized, report);
  checkDashes(normalized, report);
  return { normalized: report.errors.length ? null : normalized, ...report };
};

/**
 * Checks a submitted guide. With an attempt's context, `snapshot` is the files the
 * agent reviews (the skipped ones are left out) and the focus areas must be answered.
 */
export const normalizeGuide = (
  guide: Guide,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null = null,
) => normalize(guide, snapshot, "guide", context);

/**
 * A draft is checked like a guide, except that it may leave files out and plan
 * chapters it hasn't written yet (no files). Everything it does reference must resolve.
 */
export const normalizeDraft = (
  draft: DraftGuide,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null = null,
) => normalize(draft, snapshot, "draft", context);

const signed = (file: SkippedFile) => `+${file.additions} -${file.deletions}`;

/**
 * Adds prkit's own last chapter listing the files the ignore rules skipped, each
 * with its counts and the rule that decided it. Nothing to add when none were.
 */
export const withSkippedChapter = (
  guide: NormalizedGuide,
  skipped: ReadonlyArray<SkippedFile>,
): NormalizedGuide => {
  if (skipped.length === 0) return guide;
  const files = skipped.map((file) => ({
    path: file.path,
    note: `${signed(file)} · skipped by ${file.reasons
      .map((reason) =>
        reason.path === file.path || file.reasons.length === 1
          ? describeRule(reason)
          : `${describeRule(reason)} for the old path \`${reason.path}\``,
      )
      .join(" and ")}`,
    collapsed: true,
    annotations: [],
  }));
  const count = `${skipped.length} file${skipped.length === 1 ? "" : "s"}`;
  return {
    ...guide,
    chapters: [
      ...guide.chapters,
      {
        id: SKIPPED_CHAPTER_ID,
        title: "Skipped by your ignore rules",
        kind: "generated",
        body: [
          `prkit left ${count} out of the guide because your ignore rules skip ${skipped.length === 1 ? "it" : "them"}. The agent didn't review ${skipped.length === 1 ? "it" : "them"}; the diffs are here if you want to look.`,
        ],
        pseudocode: null,
        callouts: [],
        files,
        risk: null,
      },
    ],
  };
};

/** Every changed file in exactly one chapter, and no chapter file outside the diff. */
export const coverageProblems = (guide: NormalizedGuide, snapshot: DiffSnapshot) => {
  const problems: Array<string> = [];
  const changed = new Set(snapshot.files.map((file) => file.path));
  const owner = new Map<string, string>();
  for (const chapter of guide.chapters)
    for (const file of chapter.files) {
      if (!changed.has(file.path))
        problems.push(`\`${file.path}\` in \`${chapter.id}\` is not a file in this PR.`);
      const previous = owner.get(file.path);
      if (previous !== undefined)
        problems.push(`\`${file.path}\` is in both \`${previous}\` and \`${chapter.id}\`.`);
      owner.set(file.path, chapter.id);
    }
  for (const path of changed)
    if (!owner.has(path)) problems.push(`\`${path}\` is not in any chapter.`);
  return problems;
};

const isPlanned = (chapter: RawChapter) =>
  (chapter.files ?? []).length === 0 && asList(chapter.body).length === 0;

/**
 * A streamed draft can point at chapters the agent hasn't written yet: the flow
 * comes before the chapters. Leaves those references out so the rest still renders;
 * each one comes back once its chapter lands.
 */
export const withoutUnwrittenChapters = (draft: DraftGuide): DraftGuide => {
  const chapters = draft.chapters ?? [];
  const ids = new Set(chapters.map(chapterKey));
  const written = (reference: string | number | undefined) =>
    reference === undefined ||
    reference === "" ||
    (typeof reference === "number"
      ? Number.isInteger(reference) && reference >= 1 && reference <= chapters.length
      : ids.has(slugify(reference)));
  const unlinked = <T extends { readonly chapter?: string | number }>(item: T) => {
    if (written(item.chapter)) return item;
    const { chapter: _, ...rest } = item;
    return rest;
  };
  return {
    ...draft,
    ...(draft.flow === undefined
      ? {}
      : {
          flow: {
            ...draft.flow,
            ...(draft.flow.nodes === undefined ? {} : { nodes: draft.flow.nodes.map(unlinked) }),
            ...(draft.flow.rows === undefined ? {} : { rows: draft.flow.rows.map(unlinked) }),
          },
        }),
    ...(draft.focus === undefined ? {} : { focus: draft.focus.map(unlinked) }),
    ...(draft.risk?.reasons === undefined
      ? {}
      : { risk: { ...draft.risk, reasons: draft.risk.reasons.map(unlinked) } }),
  };
};

/**
 * Adds one `submit_draft` call to the draft so far. Fields it sends replace the
 * old ones; chapters merge by id, new ones go last, and a planned chapter never
 * replaces one that is already written.
 */
export const mergeDraft = (previous: DraftGuide | null, next: DraftGuide): DraftGuide => {
  const chapters = [...(previous?.chapters ?? [])];
  for (const chapter of next.chapters ?? []) {
    const index = chapters.findIndex((existing) => chapterKey(existing) === chapterKey(chapter));
    const existing = chapters[index];
    if (existing === undefined) chapters.push(chapter);
    else if (!isPlanned(chapter) || isPlanned(existing)) chapters[index] = chapter;
  }
  return { ...previous, ...next, chapters };
};

/** The rejected guide with one `revise_guide` call applied, ready to be checked again. */
export const patchGuide = (rejected: Guide, patch: GuidePatch): Guide => {
  const sent = patch.chapters ?? [];
  const replacements = new Map(sent.map((chapter) => [chapterKey(chapter), chapter]));
  const existing = new Set(rejected.chapters.map(chapterKey));
  return {
    ...rejected,
    ...patch,
    chapters: Arr.appendAll(
      Arr.map(rejected.chapters, (chapter) => replacements.get(chapterKey(chapter)) ?? chapter),
      sent.filter((chapter) => !existing.has(chapterKey(chapter))),
    ),
  };
};
