import { processFile, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { diffRows, type DiffFile, type DiffRow } from "@prkit/contracts";

type RenderableDiff =
  | { kind: "diff"; fileDiff: FileDiffMetadata }
  | { kind: "message"; message: string; raw?: string };

export function buildFileDiff(file: DiffFile): RenderableDiff {
  if (file.patch._tag === "binary")
    return { kind: "message", message: "Binary file. No text diff is available." };
  if (file.patch._tag === "too-large")
    return {
      kind: "message",
      message: `This diff is too large to display (${file.patch.lines.toLocaleString()} lines). Open the file on GitHub to review it.`,
    };
  if (file.status === "renamed" && file.additions + file.deletions === 0)
    return {
      kind: "message",
      message: `Renamed from ${file.previousPath} with no content changes.`,
    };
  if (!file.patch.patch.trim())
    return { kind: "message", message: "This file has no text changes." };
  try {
    let hash = 0x811c9dc5;
    for (let i = 0; i < file.patch.patch.length; i++)
      hash = Math.imul(hash ^ file.patch.patch.charCodeAt(i), 0x01000193);
    const fileDiff = processFile(file.patch.patch, {
      isGitDiff: true,
      throwOnError: true,
      cacheKey: `${file.path}:${file.patch.patch.length}:${hash >>> 0}`,
    });
    if (fileDiff?.hunks.length) return { kind: "diff", fileDiff };
  } catch {
    return {
      kind: "message",
      message: "This diff could not be parsed. You can still review the raw patch below.",
      raw: file.patch.patch,
    };
  }
  return { kind: "message", message: "This diff has no displayable hunks.", raw: file.patch.patch };
}

const rowsOf = new WeakMap<DiffFile, ReadonlyArray<DiffRow>>();
const noRows: ReadonlyArray<DiffRow> = [];

/** The file's patch rows, parsed once per file. */
export function fileRows(file: DiffFile) {
  if (file.patch._tag !== "text") return noRows;
  let rows = rowsOf.get(file);
  if (!rows) {
    rows = diffRows(file.patch.patch);
    rowsOf.set(file, rows);
  }
  return rows;
}

const patchShapes = new WeakMap<DiffFile, { context: number; hunks: number }>();

export function estimateDiffHeight(
  file: DiffFile,
  diffStyle: "unified" | "split",
  notes: number,
  chips: number,
) {
  if (
    file.patch._tag !== "text" ||
    !file.patch.patch ||
    (file.status === "renamed" && file.additions + file.deletions === 0)
  )
    return 56;
  let shape = patchShapes.get(file);
  if (!shape) {
    shape = { context: 0, hunks: 0 };
    for (const line of file.patch.patch.split("\n")) {
      if (line.startsWith(" ")) shape.context++;
      else if (line.startsWith("@@")) shape.hunks++;
    }
    patchShapes.set(file, shape);
  }
  const changed =
    diffStyle === "split"
      ? Math.max(file.additions, file.deletions)
      : file.additions + file.deletions;
  const separators = file.status === "added" ? 0 : shape.hunks + 1;
  return 16 + (shape.context + changed) * 20 + separators * 24 + notes * 90 + chips * 28;
}

export function labelTrailingSeparator<Annotation>(
  trailingLines: number,
): NonNullable<FileDiffOptions<Annotation, undefined>["onPostRender"]> {
  const text = `${trailingLines} unmodified line${trailingLines === 1 ? "" : "s"}`;
  return (host, instance, phase) => {
    if (phase === "unmount" || !instance.fileDiff?.isPartial) return;
    for (const separator of host.shadowRoot?.querySelectorAll<HTMLElement>(
      "[data-separator-last]",
    ) ?? []) {
      if (trailingLines === 0) separator.style.display = "none";
      else {
        const label = separator.querySelector("[data-unmodified-lines]");
        if (label && label.textContent !== text) label.textContent = text;
      }
    }
  };
}
