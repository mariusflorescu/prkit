import type { DiffFile } from "@prkit/contracts";
import { useMemo } from "react";

import { FileTreeBranch } from "./FileTreeBranch";
import { buildFileTree } from "./treeModel";
import "./diff.css";

export type FileTreeProps = {
  files: ReadonlyArray<DiffFile>;
  activePath?: string | undefined;
  /** How many files the PR has, when `files` is only some of them. */
  total?: number;
  onSelect: (path: string) => void;
  order?: "path" | "reading";
};

export function FileTree({ files, activePath, total, onSelect, order = "path" }: FileTreeProps) {
  const entries = useMemo(() => buildFileTree(files, order), [files, order]);
  return (
    <nav data-file-tree="" aria-label="Changed files">
      <h3>
        Files{" "}
        <span>
          {total === undefined || total === files.length
            ? files.length
            : `${files.length} of ${total}`}
        </span>
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
