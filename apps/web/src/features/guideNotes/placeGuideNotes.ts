import {
  capture,
  compareVersions,
  type DiffFile,
  type DiffRow,
  diffRows,
  type GuideRevision,
  type LinePoint,
  type NormalizedGuide,
  type NoteRef,
  notePoint,
  placeOn,
  type PullRequestFiles,
  SKIPPED_CHAPTER_ID,
} from "@prkit/contracts";

import { versionOf } from "~/features/reviewedFiles/useReviewedFiles";

type LineNote = NormalizedGuide["chapters"][number]["files"][number]["annotations"][number];

/** One line note of a revision where GitHub's diff shows its line now. */
export type PlacedNote = {
  /** Its place in the revision, which is how the server finds it again. */
  readonly ref: NoteRef;
  /** As the guide wrote it, on the revision's rows, which its NoteKey comes from. */
  readonly written: LineNote;
  readonly writtenRows: ReadonlyArray<DiffRow>;
  /** The head the revision's diff is on. */
  readonly writtenHead: string;
  readonly at: LinePoint;
};

export type FileGuideNotes = {
  readonly note: string | null;
  /** Each placed line note at its line now, in the revision's order. */
  readonly annotations: ReadonlyArray<LineNote>;
};

export type FilesGuideNotes = {
  readonly revision: number;
  /** The revision was written for another head than GitHub's now. */
  readonly older: boolean;
  /** Line and file notes left out because they no longer apply. */
  readonly hidden: number;
  /** Only files with something that lands. */
  readonly files: ReadonlyMap<string, FileGuideNotes>;
  /** The placed note behind an annotation object the diff hands back: identity, not position. */
  readonly byShown: ReadonlyMap<LineNote, PlacedNote>;
};

// A file note has no lines around it to match, so it stays only on the very change it explains.
const sameChange = (
  written: DiffFile | undefined,
  current: PullRequestFiles["files"][number] | undefined,
) => {
  if (written === undefined || current === undefined) return false;
  const before = versionOf(written);
  const now = versionOf(current);
  return before !== null && now !== null && compareVersions(before, now) === "same";
};

/** A revision's notes where they still apply to GitHub's diff now; the rest are only counted. */
export const placeGuideNotes = (
  revision: GuideRevision,
  files: PullRequestFiles,
): FilesGuideNotes => {
  const writtenFiles = new Map(revision.snapshot.files.map((file) => [file.path, file]));
  const currentFiles = new Map(files.files.map((file) => [file.path, file]));
  const placed = new Map<string, FileGuideNotes>();
  const byShown = new Map<LineNote, PlacedNote>();
  let hidden = 0;
  for (const chapter of revision.normalized.chapters) {
    // Its notes restate the ignore rules, not the code.
    if (chapter.id === SKIPPED_CHAPTER_ID) continue;
    for (const entry of chapter.files) {
      const { path } = entry;
      const writtenFile = writtenFiles.get(path);
      const writtenRows =
        writtenFile?.patch._tag === "text" ? diffRows(writtenFile.patch.patch) : [];
      const annotations: Array<LineNote> = [];
      entry.annotations.forEach((written, index) => {
        const point = notePoint(written);
        const captured = capture(writtenRows, { path, start: point, end: point }, revision.headSha);
        const placed = captured && placeOn(captured, files);
        if (placed === null || placed._tag === "outdated") {
          hidden++;
          return;
        }
        const at = placed.placement.anchor.end;
        const shown = { ...written, line: at.line };
        annotations.push(shown);
        byShown.set(shown, {
          ref: { revision: revision.revision, path, index },
          written,
          writtenRows,
          writtenHead: revision.headSha,
          at,
        });
      });
      const keepsNote = entry.note !== null && sameChange(writtenFile, currentFiles.get(path));
      if (entry.note !== null && !keepsNote) hidden++;
      const note = keepsNote ? entry.note : null;
      if (note !== null || annotations.length > 0) placed.set(path, { note, annotations });
    }
  }
  return {
    revision: revision.revision,
    older: revision.headSha !== files.headSha,
    hidden,
    files: placed,
    byShown,
  };
};
