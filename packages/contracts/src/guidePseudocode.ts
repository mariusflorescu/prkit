import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DiffSnapshot } from "./diffSnapshot.ts";
import {
  type Guide,
  type NormalizedGuide,
  type NormalizedPseudocodePair,
  PseudocodePair,
} from "./guide.ts";
import { type Report, chapterKey } from "./guideCheck.ts";

type Chapter = NormalizedGuide["chapters"][number];
type RawChapter = Pick<Guide["chapters"][number], "id" | "title" | "pseudocode">;

type Line<Change extends "added" | "removed"> = {
  readonly text: string;
  readonly status: Change | "unchanged";
};
/** One row of the split view. A null side is a filler across from the other side's change. */
export interface PseudocodeRow {
  readonly before: Line<"removed"> | null;
  readonly after: Line<"added"> | null;
}

// Some agents' tool calls send the pair JSON-encoded, which the schema reads as one block.
const decodeEncodedPair = Schema.decodeUnknownOption(Schema.fromJsonString(PseudocodePair));
const PSEUDOCODE_LINES_MAX = 10;
const PSEUDOCODE_LINE_WIDTH_MAX = 72;
const PAIRLESS_KINDS = new Set<Chapter["kind"]>(["tests", "docs", "generated"]);

/** Line endings as `\n`, no trailing spaces, and no blank line at either end. */
const tidy = (text: string) => {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
};

/**
 * The pair as a split diff: lines both sides share once, on both sides, and between them
 * the removed lines next to the added ones, in order. Lines match when their text is the
 * same, indentation included; the longest run of shared lines wins, and inside a change
 * removed lines come before added ones.
 */
export const pseudocodeRows = (pair: NormalizedPseudocodePair): ReadonlyArray<PseudocodeRow> => {
  const before = pair.before.split("\n");
  const after = pair.after.split("\n");
  const width = after.length + 1;
  const table = Array.from({ length: (before.length + 1) * width }, () => 0);
  const shared = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? shared(i + 1, j + 1) + 1
          : Math.max(shared(i + 1, j), shared(i, j + 1));
  const rows: Array<PseudocodeRow> = [];
  let removed: Array<string> = [];
  let added: Array<string> = [];
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const gone = removed[k];
      const fresh = added[k];
      rows.push({
        before: gone === undefined ? null : { text: gone, status: "removed" },
        after: fresh === undefined ? null : { text: fresh, status: "added" },
      });
    }
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const old = before[i];
    const now = after[j];
    if (old !== undefined && old === now) {
      flush();
      rows.push({
        before: { text: old, status: "unchanged" },
        after: { text: now, status: "unchanged" },
      });
      i++;
      j++;
    } else if (old !== undefined && (now === undefined || shared(i + 1, j) >= shared(i, j + 1))) {
      removed.push(old);
      i++;
    } else {
      if (now !== undefined) added.push(now);
      j++;
    }
  }
  flush();
  return rows;
};

const checkPair = (
  chapter: Chapter,
  pair: NormalizedPseudocodePair,
  snapshot: DiffSnapshot,
  report: Report,
) => {
  const owner = `chapter \`${chapter.id}\``;
  const statuses = new Map(snapshot.files.map((file) => [file.path, file.status]));
  if (PAIRLESS_KINDS.has(chapter.kind))
    report.errors.push(
      `${owner} is a \`${chapter.kind}\` chapter, and a before/after is for logic that changed shape. Send \`pseudocode\` as one string, or leave it out.`,
    );
  // A planned chapter in a draft has no files yet, and every() of none is true.
  else if (
    chapter.files.length > 0 &&
    chapter.files.every((file) => statuses.get(file.path) === "added")
  )
    report.errors.push(
      `${owner}: every file is new in this PR, so there is no before. Send \`pseudocode\` as one string. If this code replaces logic from a file the PR deletes, put that file in this chapter.`,
    );
  if (pair.before === "")
    report.errors.push(
      `${owner}: \`pseudocode.before\` is empty. A pair shows logic that already existed and changed shape. For code this PR only adds, send \`pseudocode\` as one string, or leave it out.`,
    );
  if (pair.after === "")
    report.errors.push(
      `${owner}: \`pseudocode.after\` is empty. For logic this PR removes, say in the body what is gone and leave \`pseudocode\` out.`,
    );
  for (const side of ["before", "after"] as const) {
    const lines = pair[side].split("\n");
    if (pair[side] !== "" && lines.length > PSEUDOCODE_LINES_MAX)
      report.errors.push(
        `${owner}: \`pseudocode.${side}\` is ${lines.length} lines - past ${PSEUDOCODE_LINES_MAX} it stops being a quick read. Keep the 3-8 lines that show the change and leave the rest to the diff.`,
      );
    const long = lines.findIndex((line) => Array.from(line).length > PSEUDOCODE_LINE_WIDTH_MAX);
    if (long >= 0)
      report.warnings.push(
        `${owner}: \`pseudocode.${side}\` line ${long + 1} is ${Array.from(lines[long] ?? "").length} characters. Keep lines under about 60 so the two sides fit side by side.`,
      );
  }
  if (pair.before === "" || pair.after === "") return;
  const kept = new Set(pair.before.split("\n"));
  if (pair.before === pair.after)
    report.errors.push(
      `${owner}: \`pseudocode.before\` and \`pseudocode.after\` are the same, so the pair shows no change. Show what changed between them, or send \`pseudocode\` as one string.`,
    );
  else if (!pair.after.split("\n").some((line) => kept.has(line)))
    report.warnings.push(
      `${owner}: \`pseudocode.before\` and \`pseudocode.after\` share no line, so every line shows as changed. Write the lines that work the same word for word, indentation included, on both sides.`,
    );
};

/**
 * Checks each chapter's `pseudocode` and fills it in. `chapters` are normalized, with their
 * files resolved, since a pair is only for logic that existed before this change.
 */
export const normalizePseudocode = (input: {
  readonly raw: ReadonlyArray<RawChapter>;
  readonly chapters: ReadonlyArray<Chapter>;
  readonly snapshot: DiffSnapshot;
  readonly report: Report;
}): ReadonlyArray<Chapter> => {
  const raws = new Map(input.raw.map((chapter) => [chapterKey(chapter), chapter.pseudocode]));
  return input.chapters.map((chapter) => {
    const sent = raws.get(chapter.id);
    const raw =
      typeof sent === "string"
        ? Option.getOrElse(
            Option.filter(
              decodeEncodedPair(sent),
              (pair) => pair.before !== undefined || pair.after !== undefined,
            ),
            () => sent,
          )
        : sent;
    if (raw === undefined || typeof raw === "string")
      return { ...chapter, pseudocode: raw || null };
    const pair = { before: tidy(raw.before ?? ""), after: tidy(raw.after ?? "") };
    checkPair(chapter, pair, input.snapshot, input.report);
    return { ...chapter, pseudocode: pair };
  });
};

/** The agent's pseudocode, for the checks that read all of the guide's text. */
export function* pseudocodeTexts(chapter: Chapter) {
  const pseudocode = chapter.pseudocode;
  if (pseudocode === null) return;
  if (typeof pseudocode === "string") yield pseudocode;
  else yield* [pseudocode.before, pseudocode.after];
}
