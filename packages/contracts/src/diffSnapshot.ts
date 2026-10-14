import * as Schema from "effect/Schema";

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
});
export type DiffFile = typeof DiffFile.Type;

export const DiffSnapshot = Schema.Struct({ files: Schema.Array(DiffFile) });
export type DiffSnapshot = typeof DiffSnapshot.Type;
