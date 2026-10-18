import * as Schema from "effect/Schema";

import { BlobId, type DiffFile } from "./diffSnapshot.ts";
import { AccountId, PullRequestKey } from "./ids.ts";
import type { PullRequestFile } from "./pullRequest.ts";
import { fnv1a64 } from "./textHash.ts";

/**
 * The files the user marked reviewed (docs/internals/architecture.md "Reviewed files").
 * prkit shows one change through two diffs: the Files tab reads GitHub's files API and a
 * guide reads the git snapshot its attempt froze. Their patches differ in headers, line
 * numbers after a base merge, and where each gives up on a large file. So a mark records
 * a file version that both can compute, and every surface derives its own state from
 * the file it shows and the marks, with the functions below.
 */

/** FNV-1a of the patch's hunks with headers and line numbers stripped. */
export const HunksHash = Schema.NonEmptyString.pipe(Schema.brand("HunksHash"));
export type HunksHash = typeof HunksHash.Type;

/** How the file ends after the change: its new blob, or deleted. */
export const FileEnd = Schema.Union([Schema.Literal("deleted"), BlobId]);
export type FileEnd = typeof FileEnd.Type;

/**
 * One version of one file's change. At least one side is known: a stored snapshot's
 * binary or too-large file from before prkit kept blobs has neither, and no version.
 */
export const FileVersion = Schema.Union([
  Schema.Struct({ hunks: HunksHash, end: Schema.NullOr(FileEnd) }),
  Schema.Struct({ hunks: Schema.Null, end: FileEnd }),
]);
export type FileVersion = typeof FileVersion.Type;

/**
 * One decision about one version of one path. The newest decision for a version wins:
 * `order` grows with every saved decision, so two in the same millisecond still rank.
 */
export const ReviewedMark = Schema.Struct({
  path: Schema.String,
  version: FileVersion,
  reviewed: Schema.Boolean,
  order: Schema.Int,
});
export type ReviewedMark = typeof ReviewedMark.Type;

/** Every decision for one PR as one account reads it. */
export const ReviewedMarks = Schema.Struct({ marks: Schema.Array(ReviewedMark) });
export type ReviewedMarks = typeof ReviewedMarks.Type;

/** Marks or unmarks these versions. Setting, never toggling, so a retry changes nothing. */
export const ReviewedDecision = Schema.Struct({
  files: Schema.NonEmptyArray(Schema.Struct({ path: Schema.String, version: FileVersion })),
  reviewed: Schema.Boolean,
});
export type ReviewedDecision = typeof ReviewedDecision.Type;

/** `connected` once the subscription is live, then one `changed` per saved decision. */
export const ReviewedFilesChange = Schema.Union([
  Schema.TaggedStruct("connected", {}),
  Schema.TaggedStruct("changed", { key: PullRequestKey, accountId: AccountId }),
]);
export type ReviewedFilesChange = typeof ReviewedFilesChange.Type;

export class ReviewedFilesError extends Schema.TaggedError<ReviewedFilesError>()(
  "ReviewedFilesError",
  {
    key: PullRequestKey,
    accountId: AccountId,
    reason: Schema.Literals(["storage", "not-a-changed-file", "moved"]),
    message: Schema.String,
  },
) {}

/**
 * `unknown` is a file with no version (see FileVersion): it can't be marked and isn't counted.
 * `changed` is a file whose newest decision about another version of it, under its path or
 * the path it was renamed from, marked that version reviewed.
 */
export const FileReviewState = Schema.Literals(["reviewed", "changed", "unreviewed", "unknown"]);
export type FileReviewState = typeof FileReviewState.Type;

export const ReviewProgress = Schema.Struct({
  reviewed: Schema.Int,
  changed: Schema.Int,
  total: Schema.Int,
});
export type ReviewProgress = typeof ReviewProgress.Type;

export const ChapterReview = Schema.Struct({
  state: Schema.Literals(["reviewed", "partial", "unreviewed"]),
  progress: ReviewProgress,
});
export type ChapterReview = typeof ChapterReview.Type;

/** What a file needs to be marked: a live PullRequestFile and a snapshot's DiffFile both fit. */
export type ReviewableFile = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: DiffFile["status"] | (typeof PullRequestFile.Type)["status"];
  readonly patch: DiffFile["patch"];
  readonly blob?: BlobId | undefined;
};

/** Newest first per path. Built once per marks value. */
export type ReviewedIndex = ReadonlyMap<string, ReadonlyArray<ReviewedMark>>;

/**
 * The hunks as a reviewer reads them: lines before the first `@@` (git's headers) and
 * the trailing newline dropped, each `@@ -a,b +c,d @@ heading` reduced to `@@`, so a
 * base merge that only moves line numbers keeps the same text. Content lines start with
 * ' ', '+', '-' or '\', so none is taken for a hunk header. Null without any hunk.
 */
export const normalizedHunks = (patch: string): string | null => {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = lines.findIndex((line) => line.startsWith("@@"));
  if (start < 0) return null;
  return lines
    .slice(start)
    .map((line) => (line.startsWith("@@") ? "@@" : line))
    .join("\n");
};

export const fileVersion = (file: ReviewableFile): FileVersion | null => {
  const hunks = file.patch._tag === "text" ? normalizedHunks(file.patch.patch) : null;
  const end = file.status === "removed" ? "deleted" : (file.blob ?? null);
  if (hunks !== null) return { hunks: HunksHash.make(fnv1a64(hunks)), end };
  if (end !== null) return { hunks: null, end };
  return null;
};

/**
 * Two versions are one change when their hunks read the same. Only when either side
 * has no hunks (binary, a rename or mode change alone, a patch one source gave up on)
 * do they compare by how the file ends. When the two share neither side, such as a
 * guide stored before prkit kept blob ids against a file GitHub sent no patch for,
 * nothing says whether they are one change: `unknown`.
 */
export const compareVersions = (
  a: FileVersion,
  b: FileVersion,
): "same" | "different" | "unknown" => {
  if (a.hunks !== null && b.hunks !== null) return a.hunks === b.hunks ? "same" : "different";
  if (a.end !== null && b.end !== null) return a.end === b.end ? "same" : "different";
  return "unknown";
};

export const indexMarks = ({ marks }: ReviewedMarks): ReviewedIndex => {
  const index = new Map<string, Array<ReviewedMark>>();
  for (const mark of marks) {
    const list = index.get(mark.path);
    if (list === undefined) index.set(mark.path, [mark]);
    else list.push(mark);
  }
  for (const list of index.values()) list.sort((a, b) => b.order - a.order);
  return index;
};

export const fileReviewState = (
  file: ReviewableFile,
  index: ReviewedIndex,
  version: FileVersion | null = fileVersion(file),
): FileReviewState => {
  if (version === null) return "unknown";
  const marks = index.get(file.path) ?? [];
  const decided = marks.find((mark) => compareVersions(mark.version, version) === "same");
  if (decided !== undefined) return decided.reviewed ? "reviewed" : "unreviewed";
  const renamed =
    file.status === "renamed" && file.previousPath !== null
      ? (index.get(file.previousPath) ?? [])
      : [];
  const newest = [
    ...marks.filter((mark) => compareVersions(mark.version, version) === "different"),
    ...renamed,
  ].reduce<ReviewedMark | null>(
    (latest, mark) => (latest === null || mark.order > latest.order ? mark : latest),
    null,
  );
  return newest?.reviewed === true ? "changed" : "unreviewed";
};

export const reviewProgress = (states: Iterable<FileReviewState>): ReviewProgress => {
  const progress = { reviewed: 0, changed: 0, total: 0 };
  for (const state of states) {
    if (state === "unknown") continue;
    progress.total++;
    if (state === "reviewed") progress.reviewed++;
    if (state === "changed") progress.changed++;
  }
  return progress;
};

/** Derived from its files, never stored. Null when nothing in the chapter can be marked. */
export const chapterReview = <File extends ReviewableFile>(
  files: ReadonlyArray<File>,
  stateOf: (file: File) => FileReviewState,
): ChapterReview | null => {
  const progress = reviewProgress(files.map(stateOf));
  if (progress.total === 0) return null;
  const state =
    progress.reviewed === progress.total
      ? "reviewed"
      : progress.reviewed > 0
        ? "partial"
        : "unreviewed";
  return { state, progress };
};

/** The one way to build a write: files without a version are left out, null when none is left. */
export const reviewedDecision = (
  files: ReadonlyArray<ReviewableFile>,
  reviewed: boolean,
): ReviewedDecision | null => {
  const [first, ...rest] = files.flatMap((file) => {
    const version = fileVersion(file);
    return version === null ? [] : [{ path: file.path, version }];
  });
  return first === undefined ? null : { files: [first, ...rest], reviewed };
};
