import type { DiffFile, DiffSnapshot } from "@prkit/contracts";

/**
 * A file whose patch passes either limit is stored as `too-large`: it keeps its
 * counts but no text, so it can't take line notes. 5,000 lines is far more than a
 * reviewer reads in one file, and keeping such patches out keeps attempt rows and
 * the guide view small. GitHub's own files API gives up earlier, at about 3,000
 * lines per file.
 */
export const MAX_PATCH_LINES = 5_000;
export const MAX_PATCH_BYTES = 512 * 1024;

type RawEntry = {
  readonly status: DiffFile["status"];
  readonly path: string;
  readonly previousPath: string | null;
};
type NumstatEntry = {
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly path: string;
};

const statusOf = (letter: string): DiffFile["status"] | null => {
  switch (letter) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "removed";
    case "M":
    case "T":
      return "modified";
    case "R":
      return "renamed";
    default:
      return null;
  }
};

/** `git diff -z --raw`: `:<modes> <shas> <status>\0<path>\0` with a second path for renames. */
const parseRaw = (output: string): ReadonlyArray<RawEntry> | string => {
  const tokens = output.split("\0");
  const entries: Array<RawEntry> = [];
  for (let index = 0; index < tokens.length;) {
    const meta = tokens[index] ?? "";
    if (meta === "") {
      index++;
      continue;
    }
    const letter = meta.split(" ").at(-1)?.charAt(0) ?? "";
    const status = statusOf(letter);
    if (!meta.startsWith(":") || status === null) return `unexpected raw diff entry ${meta}`;
    const first = tokens[index + 1] ?? "";
    if (letter === "R" || letter === "C") {
      const second = tokens[index + 2] ?? "";
      entries.push({ status, path: second, previousPath: status === "renamed" ? first : null });
      index += 3;
    } else {
      entries.push({ status, path: first, previousPath: null });
      index += 2;
    }
  }
  return entries;
};

/** `git diff -z --numstat`: `<add>\t<del>\t<path>\0`, or `<add>\t<del>\t\0<old>\0<new>\0` for renames. */
const parseNumstat = (output: string): ReadonlyArray<NumstatEntry> => {
  const tokens = output.split("\0");
  const entries: Array<NumstatEntry> = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index] ?? "";
    if (token === "") {
      index++;
      continue;
    }
    const [added = "", deleted = "", path = ""] = token.split("\t");
    const binary = added === "-" && deleted === "-";
    const counts = {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
    };
    if (path === "") {
      entries.push({ ...counts, binary, path: tokens[index + 2] ?? "" });
      index += 3;
    } else {
      entries.push({ ...counts, binary, path });
      index += 1;
    }
  }
  return entries;
};

/** One section per file. Patch content lines start with ' ', '+', '-' or '\', so a header can't hide inside one. */
const splitPatch = (output: string): ReadonlyArray<string> => {
  const sections: Array<string> = [];
  let current: Array<string> | null = null;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(`${current.join("\n")}\n`);
      current = [line];
    } else current?.push(line);
  }
  if (current) sections.push(`${current.join("\n")}\n`);
  return sections;
};

/** Builds the snapshot from three `git diff` runs with the same options, which list files in the same order. */
export const buildDiffSnapshot = (input: {
  readonly raw: string;
  readonly numstat: string;
  readonly patch: string;
}):
  | { readonly _tag: "ok"; readonly snapshot: DiffSnapshot }
  | { readonly _tag: "error"; readonly message: string } => {
  const raw = parseRaw(input.raw);
  if (typeof raw === "string") return { _tag: "error", message: raw };
  const numstat = parseNumstat(input.numstat);
  const patches = splitPatch(input.patch);
  if (numstat.length !== raw.length || patches.length !== raw.length)
    return {
      _tag: "error",
      message: `git listed ${raw.length} files but ${numstat.length} counts and ${patches.length} patches`,
    };
  const files: Array<DiffFile> = [];
  for (const [index, entry] of raw.entries()) {
    const stat = numstat[index];
    const patch = patches[index];
    if (stat === undefined || patch === undefined || stat.path !== entry.path)
      return { _tag: "error", message: `git listed files in different orders at ${entry.path}` };
    const lines = patch.split("\n").length - 1;
    files.push({
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      additions: stat.additions,
      deletions: stat.deletions,
      patch: stat.binary
        ? { _tag: "binary" }
        : lines > MAX_PATCH_LINES || patch.length > MAX_PATCH_BYTES
          ? { _tag: "too-large", lines: stat.additions + stat.deletions }
          : { _tag: "text", patch },
    });
  }
  return { _tag: "ok", snapshot: { files } };
};
