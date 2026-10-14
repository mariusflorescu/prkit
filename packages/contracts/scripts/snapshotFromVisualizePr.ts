// @effect-diagnostics-next-line nodeBuiltinImport:off -- This offline converter reads and writes fixture files.
import * as NodeFs from "node:fs/promises";
import * as Schema from "effect/Schema";

import { type DiffFile, DiffSnapshot } from "../src/diffSnapshot.ts";

const VisualizePr = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      previousPath: Schema.NullOr(Schema.String),
      status: Schema.Literals(["added", "modified", "removed", "renamed", "changed", "copied"]),
      additions: Schema.Int,
      deletions: Schema.Int,
      patch: Schema.NullOr(Schema.String),
      binary: Schema.Boolean,
    }),
  ),
});

const statuses = {
  added: "added",
  modified: "modified",
  removed: "removed",
  renamed: "renamed",
  changed: "modified",
  copied: "added",
} as const;

const patchFromFile = (file: (typeof VisualizePr.Type.files)[number]): DiffFile["patch"] => {
  if (file.binary) return { _tag: "binary" };
  if (file.patch !== null) return { _tag: "text", patch: file.patch };
  if (file.additions === 0 && file.deletions === 0) return { _tag: "text", patch: "" };
  return { _tag: "too-large", lines: file.additions + file.deletions };
};

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  process.stderr.write(
    "usage: node packages/contracts/scripts/snapshotFromVisualizePr.ts <pr.json> <snapshot.json>\n",
  );
  process.exit(2);
}
const pr = Schema.decodeUnknownSync(Schema.fromJsonString(VisualizePr))(
  await NodeFs.readFile(input, "utf8"),
);
const snapshot: DiffSnapshot = {
  files: pr.files.map((file) => ({
    path: file.path,
    previousPath: file.previousPath,
    status: statuses[file.status],
    additions: file.additions,
    deletions: file.deletions,
    patch: patchFromFile(file),
  })),
};
const json = Schema.encodeSync(Schema.fromJsonString(DiffSnapshot, { space: 2 }))(snapshot);
await NodeFs.writeFile(output, json + "\n");
