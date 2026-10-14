import type { DiffFile } from "@prkit/contracts";
import { useMemo } from "react";

import { FileTreeBranch } from "./FileTreeBranch";
import { buildFileTree } from "./treeModel";
import "./diff.css";

export type FileTreeProps = {
  files: ReadonlyArray<DiffFile>;
  activePath?: string;
  onSelect: (path: string) => void;
  order?: "path" | "reading";
};

export function FileTree({ files, activePath, onSelect, order = "path" }: FileTreeProps) {
  const entries = useMemo(() => buildFileTree(files, order), [files, order]);
  return (
    <nav data-file-tree="" aria-label="Changed files">
      <h3>
        Files <span>{files.length}</span>
      </h3>
      {entries.length === 0 ? (
        <p role="status">No changed files.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <FileTreeBranch
              key={entry.kind === "file" ? entry.file.path : entry.path}
              entry={entry}
              activePath={activePath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
