import { DIFF_TEXT_MAX_BYTES, type FileText } from "@prkit/contracts";

/** A path a tree can hold. git refuses the rest, and one refused path would fail the whole lookup. */
export const isTreePath = (path: string) =>
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export interface TreeEntry {
  readonly type: string;
  readonly oid: string;
  /** Null when the cache doesn't hold the blob: `git ls-tree -l` prints `BAD`, and no lazy fetch runs. */
  readonly size: number | null;
}

/** `git ls-tree -z -l` output by path: `<mode> <type> <oid> <padded size>\t<path>`, NUL-separated. */
export const parseTree = (listed: string) => {
  const entries = new Map<string, TreeEntry>();
  for (const record of listed.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type = "", oid = "", size = ""] = record.slice(0, tab).split(/ +/);
    entries.set(record.slice(tab + 1), {
      type,
      oid,
      size: /^\d+$/.test(size) ? Number(size) : null,
    });
  }
  return entries;
};

/** The blobs worth reading: present in the cache and no larger than the cap. */
export const readableOids = (entries: Iterable<TreeEntry>) =>
  new Set(
    [...entries].flatMap((entry) =>
      entry.type === "blob" && entry.size !== null && entry.size <= DIFF_TEXT_MAX_BYTES
        ? [entry.oid]
        : [],
    ),
  );

const header = new TextDecoder();

/**
 * `git cat-file --batch` output for `oids`, asked in this order: per object
 * `<oid> <type> <size>\n<size bytes>\n`, or `<oid> missing\n`. The content is raw bytes, so the
 * frame is read by length. Null when the output isn't what was asked for.
 */
export const parseBatch = (output: Uint8Array, oids: ReadonlyArray<string>) => {
  const blobs = new Map<string, Uint8Array | null>();
  let at = 0;
  for (const oid of oids) {
    const end = output.indexOf(0x0a, at);
    if (end < 0) return null;
    const line = header.decode(output.subarray(at, end));
    at = end + 1;
    if (line === `${oid} missing`) {
      blobs.set(oid, null);
      continue;
    }
    const [name, type, size] = line.split(" ");
    const length = Number(size);
    if (name !== oid || type !== "blob" || !Number.isInteger(length) || at + length > output.length)
      return null;
    blobs.set(oid, output.subarray(at, at + length));
    at += length + 1;
  }
  return blobs;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const binary: FileText = { _tag: "unreadable", reason: "binary" };

/** The text of one blob, or why it isn't: a NUL byte or bytes that aren't UTF-8 make it binary. */
export const decodeBlob = (bytes: Uint8Array): FileText => {
  if (bytes.includes(0)) return binary;
  try {
    return { _tag: "text", content: utf8.decode(bytes) };
  } catch {
    return binary;
  }
};

/** What a requested path reads as, given its tree entry and the blobs `parseBatch` found. */
export const textAt = (
  entry: TreeEntry | undefined,
  blobs: ReadonlyMap<string, Uint8Array | null>,
): FileText => {
  if (entry === undefined || entry.type !== "blob" || entry.size === null)
    return { _tag: "unreadable", reason: "missing" };
  if (entry.size > DIFF_TEXT_MAX_BYTES) return { _tag: "unreadable", reason: "too-large" };
  const bytes = blobs.get(entry.oid);
  return bytes == null ? { _tag: "unreadable", reason: "missing" } : decodeBlob(bytes);
};
