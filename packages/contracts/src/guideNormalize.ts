import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

import type { DiffFile, DiffSnapshot } from "./diffSnapshot.ts";
import type { AttemptConfig, SkippedFile } from "./guideConfig.ts";
import { describeRule } from "./guideConfigResolve.ts";
import { globTokens, matchesGlob } from "./guideGlob.ts";
import {
  type DiffLineRef,
  type DraftGuide,
  type Guide,
  type GuidePatch,
  GuideFlowStatus,
  GuideKind,
  GuideRowDepth,
  type GuideRowStatus,
  GuideSide,
  GuideTone,
  type NormalizedGuide,
} from "./guide.ts";

type Report = { errors: Array<string>; warnings: Array<string> };
/** `draft` skips the checks a guide can only pass once it is finished: coverage and empty chapters. */
type Mode = "guide" | "draft";
type RawChapter = DraftChapter | Guide["chapters"][number];
type DraftChapter = NonNullable<DraftGuide["chapters"]>[number];
type Chapter = NormalizedGuide["chapters"][number];
type FileEntry = Exclude<Guide["chapters"][number]["files"][number], string>;
type Flow = NonNullable<NormalizedGuide["flow"]>;
type FlowGraph = Extract<Flow, { readonly _tag: "graph" }>;
type BehaviorDiff = Extract<Flow, { readonly _tag: "behavior" }>;
type RawFlow = NonNullable<Guide["flow"]>;
type Range = readonly [number, number];

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
}

export const checkContextOf = (config: AttemptConfig): GuideCheckContext => ({
  focusAreas: config.focusAreas.flatMap((area) =>
    area.handle === null
      ? []
      : [{ handle: area.handle, label: area.label, question: area.question }],
  ),
  skipped: config.skipped,
});

/** The chapter prkit appends for skipped files; an agent's chapter can't take its id. */
export const SKIPPED_CHAPTER_ID = "skipped-by-your-ignore-rules";
const GUIDANCE_NOTE_MAX = 300;
const FLOW_NODES_MAX = 12;
const FLOW_ROWS_MAX = 16;
const FLOW_ROW_TEXT_MAX = 90;

const isKind = Schema.is(GuideKind);
const isTone = Schema.is(GuideTone);
const isDepth = Schema.is(GuideRowDepth);
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
const statusAliases = new Map<string, typeof GuideFlowStatus.Type>([
  ["added", "added"],
  ["new", "added"],
  ["add", "added"],
  ["changed", "changed"],
  ["modified", "changed"],
  ["updated", "changed"],
  ["removed", "removed"],
  ["deleted", "removed"],
  ["gone", "removed"],
  ["unchanged", "unchanged"],
  ["same", "unchanged"],
  ["existing", "unchanged"],
]);

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "chapter";
const asList = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;
const whitespace =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const trimWhitespace = new RegExp(`^[${whitespace}]+|[${whitespace}]+$`, "gu");
const wordSeparator = new RegExp(`[${whitespace}]+`, "u");
const trim = (text: string) => text.replace(trimWhitespace, "");
const paragraphs = (value: string | ReadonlyArray<string> | undefined) =>
  asList(value).map(trim).filter(Boolean);
const words = (text: string) => (trim(text) ? trim(text).split(wordSeparator).length : 0);
const repr = (text: string) => {
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

const hunkRanges = (patch: string) => {
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

const listRanges = (ranges: ReadonlyArray<Range>) =>
  ranges.map(([low, high]) => `${low}-${high}`).join(", ") || "none";

const didYouMean = (path: string, snapshot: DiffSnapshot) => {
  const basename = path.split("/").at(-1);
  const close = snapshot.files.find((candidate) => candidate.path.endsWith("/" + basename));
  return close === undefined ? "" : ` Did you mean ${repr(close.path)}?`;
};

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

const resolveChapter = (
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

/** Appended to the outside-the-hunks message for the rows that have no new-side line of their own. */
const outsideHints: Record<typeof GuideRowStatus.Type, string> = {
  added: "",
  removed: " A removed row points at the new-side line next to its `-` lines.",
  unchanged:
    " A context row points at a line of its code the diff shows; leave the row out if the diff doesn't show it.",
};

/**
 * Where a row opens, checked like a line note: a new-side line inside a hunk of a text
 * diff, because Pierre renders only hunk lines without loaded contents and throws on a
 * selection it did not render. `hint` is appended when the line is outside the hunks.
 */
const checkDiffLine = (
  at: DiffLineRef,
  where: string,
  hint: string,
  snapshot: DiffSnapshot,
  context: GuideCheckContext | null,
  report: Report,
) => {
  const { path, line } = at;
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    const left = context?.skipped.find((candidate) => candidate.path === path);
    report.errors.push(
      left === undefined
        ? `${where}: \`${path}\` is not a file in this PR.${didYouMean(path, snapshot)}`
        : `${where}: \`${path}\` is skipped by the reviewer's ignore rules (${left.reasons.map(describeRule).join(", ")}). Point the row at a reviewed file.`,
    );
    return;
  }
  if (!Number.isInteger(line) || line < 1) {
    report.errors.push(`${where}: \`at.line\` must be a positive line number, got ${line}.`);
    return;
  }
  if (file.patch._tag !== "text") {
    report.errors.push(
      `${where}: \`${path}\` has a \`${file.patch._tag}\` patch, so \`at\` can't point into it. Point at a line of a text diff.`,
    );
    return;
  }
  const ranges = hunkRanges(file.patch.patch);
  if (ranges.additions.length === 0 && ranges.deletions.length === 0) {
    report.errors.push(
      `${where}: \`${path}\` has no diff hunks (a rename only), so \`at\` can't point into it. Point at a file with changed lines.`,
    );
    return;
  }
  if (ranges.additions.length === 0) {
    report.errors.push(
      `${where}: \`${path}\` is deleted, so it has no new-side lines. Point the row at a file that still exists, such as the code that used to call it.`,
    );
    return;
  }
  if (!ranges.additions.some(([low, high]) => low <= line && line <= high))
    report.errors.push(
      `${where}: \`${path}\` line ${line} is not a new-side line inside the diff hunks, so it can't open. New-side lines: ${listRanges(ranges.additions)}.${hint}`,
    );
};

/**
 * A behavior diff: rows like diff lines, nested like a call tree. Checks every row so one
 * rejection lists every problem.
 */
const normalizeBehavior = (
  raw: RawFlow,
  rows: NonNullable<RawFlow["rows"]>,
  chapterIds: ReadonlyArray<string>,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): BehaviorDiff | null => {
  if (rows.length === 0) {
    report.errors.push("`flow.rows` is empty. Send 4-12 rows, or a graph instead.");
    return null;
  }
  if (rows.length > FLOW_ROWS_MAX)
    report.errors.push(
      `\`flow\` has ${rows.length} rows - past ${FLOW_ROWS_MAX} it stops being a quick read. Keep the path the PR changes (4-12 rows) and leave the details to the chapters.`,
    );
  if (rows.every((row) => (row.status ?? "unchanged") === "unchanged"))
    report.errors.push(
      "`flow.rows` has no `added` or `removed` row, so it shows no change. Mark the rows this PR adds or removes.",
    );
  const normalized: Array<BehaviorDiff["rows"][number]> = [];
  let above = -1;
  for (const [index, row] of rows.entries()) {
    const where = `flow row ${index + 1}`;
    const status = row.status ?? "unchanged";
    const depth = row.depth ?? 0;
    const level = isDepth(depth) ? depth : null;
    const text = trim(row.text);
    if (!text)
      report.errors.push(`${where} has no \`text\`. Say in a few plain words what happens.`);
    if (level === null) {
      report.errors.push(
        `${where}: \`depth\` ${depth} must be 0-3. Flatten the tree: four levels is the most that stays readable.`,
      );
    } else {
      if (index === 0 && level > 0)
        report.errors.push(
          `${where}: \`depth\` ${level} has no row above it. The first row is at depth 0.`,
        );
      else if (index > 0 && above >= 0 && level > above + 1)
        report.errors.push(
          `${where}: \`depth\` ${level} follows a row at depth ${above}. A row goes at most one level deeper than the row above it.`,
        );
      above = level;
    }
    if (
      mode === "guide" &&
      status !== "unchanged" &&
      (row.chapter === undefined || row.chapter === "")
    )
      report.errors.push(
        `${where} is ${status} but has no \`chapter\`. Set it to the chapter that explains it, by id or 1-based number.`,
      );
    checkDiffLine(row.at, where, outsideHints[status], snapshot, context, report);
    normalized.push({
      status,
      text,
      depth: level ?? 0,
      at: row.at,
      chapter: resolveChapter(row.chapter, chapterIds, where, report),
    });
  }
  return {
    _tag: "behavior",
    title: raw.title || "How it fits together",
    subtitle: raw.subtitle || null,
    rows: normalized,
  };
};

/** The graph form: nodes and edges, each checked against the other. */
const normalizeGraph = (
  raw: RawFlow,
  rawNodes: NonNullable<RawFlow["nodes"]>,
  rawEdges: NonNullable<RawFlow["edges"]>,
  chapterIds: ReadonlyArray<string>,
  report: Report,
): FlowGraph | null => {
  const nodes: Array<FlowGraph["nodes"][number]> = [];
  const statuses = new Map<string, FlowGraph["nodes"][number]["status"]>();
  for (const node of rawNodes) {
    const id = trim(node.id);
    if (!id || statuses.has(id)) {
      const nodeRepr =
        "{" +
        Object.entries(node)
          .map(([key, value]) => `${repr(key)}: ${typeof value === "string" ? repr(value) : value}`)
          .join(", ") +
        "}";
      report.errors.push(`flow node ${nodeRepr}: every node needs a unique \`id\`.`);
      continue;
    }
    let status = statusAliases.get((node.status ?? "unchanged").toLowerCase());
    if (status === undefined) {
      report.errors.push(
        `flow node \`${id}\`: status must be added, changed, removed or unchanged.`,
      );
      status = "unchanged";
    }
    statuses.set(id, status);
    nodes.push({
      id,
      label: node.label || id,
      status,
      chapter: resolveChapter(node.chapter, chapterIds, `flow node \`${id}\``, report),
      detail: node.detail || null,
    });
  }
  if (nodes.length === 0) {
    report.errors.push("`flow.nodes` is empty.");
    return null;
  }
  const edges: Array<FlowGraph["edges"][number]> = [];
  for (const edge of rawEdges) {
    const fromStatus = statuses.get(edge.from);
    const toStatus = statuses.get(edge.to);
    if (fromStatus === undefined || toStatus === undefined) {
      report.errors.push(`flow edge ${edge.from} -> ${edge.to}: both ends must be node ids.`);
      continue;
    }
    let status = edge.status;
    if (status === undefined)
      status =
        fromStatus === "added" || toStatus === "added"
          ? "added"
          : fromStatus === "removed" || toStatus === "removed"
            ? "removed"
            : "unchanged";
    edges.push({
      from: edge.from,
      to: edge.to,
      label: edge.label || null,
      status: statusAliases.get(status.toLowerCase()) ?? "unchanged",
    });
  }
  if (nodes.length > FLOW_NODES_MAX)
    report.errors.push(
      `\`flow\` has ${nodes.length} nodes - past ${FLOW_NODES_MAX} it stops being readable. Keep the main path (4-10 nodes), or send a behavior diff (\`rows\`) instead.`,
    );
  const direction = (raw.direction ?? "auto").toUpperCase();
  return {
    _tag: "graph",
    title: raw.title || "How it fits together",
    subtitle: raw.subtitle || null,
    direction: direction === "LR" || direction === "TB" ? direction : "auto",
    nodes,
    edges,
  };
};

/** The before/after in the one form it was written in, or null when it was left out or is broken. */
const normalizeFlow = (
  raw: Guide["flow"],
  chapterIds: ReadonlyArray<string>,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): Flow | null => {
  if (raw === undefined) {
    if (snapshot.files.some((file) => !/\.(md|mdx|rst|txt|adoc)$/iu.test(file.path)))
      report.warnings.push(
        "no `flow` - a before/after (a graph or a behavior diff) is the fastest way to show what changed. Skip it only if this PR doesn't change what the code does.",
      );
    return null;
  }
  const isGraph = raw.nodes !== undefined || raw.edges !== undefined;
  if (isGraph && raw.rows !== undefined) {
    report.errors.push(
      "`flow` has both a graph (`nodes`/`edges`) and a behavior diff (`rows`). Pick the one form that shows this change best and send `flow` again with only that form.",
    );
    return null;
  }
  if (raw.rows !== undefined)
    return normalizeBehavior(raw, raw.rows, chapterIds, snapshot, mode, context, report);
  if (!isGraph) {
    report.errors.push(
      "`flow` needs a graph (`nodes` and `edges`) or a behavior diff (`rows`). Send one, or leave `flow` out if neither helps.",
    );
    return null;
  }
  return normalizeGraph(raw, raw.nodes ?? [], raw.edges ?? [], chapterIds, report);
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
  const flow = guide.flow;
  if (flow?._tag === "graph") {
    for (const node of flow.nodes) {
      const length = Array.from(node.label).length;
      if (length > 32)
        report.warnings.push(
          `flow node \`${node.id}\` label is ${length} chars and will be cut off - use one short identifier and put the rest in \`detail\`.`,
        );
    }
  } else if (flow?._tag === "behavior") {
    for (const [index, row] of flow.rows.entries()) {
      const length = Array.from(row.text).length;
      if (length > FLOW_ROW_TEXT_MAX)
        report.warnings.push(
          `flow row ${index + 1} is ${length} characters and will wrap - keep a row to one short line and leave the why to its chapter.`,
        );
    }
  }
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
  if (guide.flow !== null) {
    yield guide.flow.title;
    yield guide.flow.subtitle ?? "";
    if (guide.flow._tag === "graph") {
      for (const node of guide.flow.nodes) {
        yield node.label;
        yield node.detail ?? "";
      }
      for (const edge of guide.flow.edges) yield edge.label ?? "";
    } else {
      for (const row of guide.flow.rows) yield row.text;
    }
  }
  for (const item of guide.focus) yield item.text;
  for (const area of guide.focusAreas) yield area.text;
  yield guide.guidanceNote ?? "";
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
  guide: DraftGuide & Pick<Guide, "focusAreas" | "guidanceNote">,
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
  const chapters = normalizeChapters(guide.chapters ?? [], snapshot, report, mode, context);
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
    flow: normalizeFlow(guide.flow, chapterIds, snapshot, mode, context, report),
    focus,
    focusAreas:
      mode === "draft" ? [] : normalizeFocusAreas(guide.focusAreas, chapterIds, context, report),
    guidanceNote: mode === "draft" ? null : normalizeGuidanceNote(guide.guidanceNote, report),
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

const chapterKey = (chapter: RawChapter) => slugify(chapter.id || chapter.title);
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
