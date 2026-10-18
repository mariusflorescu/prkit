import * as Schema from "effect/Schema";

/** A git object id in full hex. GitHub's files API calls the new side's `sha`; `git diff --raw --no-abbrev` prints both sides. */
export const BlobId = Schema.NonEmptyString.pipe(Schema.brand("BlobId"));
export type BlobId = typeof BlobId.Type;

export const DiffFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  additions: Schema.Int,
  deletions: Schema.Int,
  patch: Schema.Union([
    Schema.TaggedStruct("text", { patch: Schema.String }),
    Schema.TaggedStruct("binary", {}),
    Schema.TaggedStruct("too-large", { lines: Schema.Int }),
  ]),
  /** The new side's blob. Absent for a removed file and in snapshots stored before prkit kept it. */
  blob: Schema.optionalKey(BlobId),
});
export type DiffFile = typeof DiffFile.Type;

export const DiffSnapshot = Schema.Struct({ files: Schema.Array(DiffFile) });
export type DiffSnapshot = typeof DiffSnapshot.Type;
