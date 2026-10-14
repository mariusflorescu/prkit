import type { DiffFile } from "@prkit/contracts";

export type FileTreeEntry =
  | { kind: "folder"; name: string; path: string; children: Array<FileTreeEntry> }
  | { kind: "file"; name: string; file: DiffFile };

export function buildFileTree(
  files: ReadonlyArray<DiffFile>,
  order: "path" | "reading",
): Array<FileTreeEntry> {
  const root: Array<FileTreeEntry> = [];
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop() ?? file.path;
    let children = root;
    let path = "";
    for (const segment of segments) {
      path += `${segment}/`;
      let folder = children.find((entry) => entry.kind === "folder" && entry.name === segment);
      if (!folder || folder.kind !== "folder") {
        folder = { kind: "folder", name: segment, path, children: [] };
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ kind: "file", name, file });
  }
  const sort = (entries: Array<FileTreeEntry>) => {
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
    );
    entries.forEach((entry) => {
      if (entry.kind === "folder") sort(entry.children);
    });
  };
  if (order === "path") sort(root);
  return root;
}
