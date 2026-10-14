import { ChevronDown, ChevronRight, FileCode2, Folder } from "lucide-react";
import { useState } from "react";

import { DiffStat } from "./DiffStat";
import type { FileTreeEntry } from "./treeModel";

export function FileTreeBranch({
  entry,
  activePath,
  onSelect,
}: {
  entry: FileTreeEntry;
  activePath?: string | undefined;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (entry.kind === "file")
    return (
      <li>
        <button
          type="button"
          data-file-tree-row=""
          aria-current={entry.file.path === activePath ? "true" : undefined}
          title={entry.file.path}
          onClick={() => onSelect(entry.file.path)}
        >
          <FileCode2 size={14} aria-hidden="true" />
          <span>{entry.name}</span>
          <small title={entry.file.status}>
            {entry.file.status === "modified" ? "" : entry.file.status.slice(0, 1).toUpperCase()}
          </small>
          <DiffStat additions={entry.file.additions} deletions={entry.file.deletions} />
        </button>
      </li>
    );
  return (
    <li>
      <button
        type="button"
        data-file-tree-row=""
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={14} />
        <span>{entry.name}</span>
      </button>
      {open && (
        <ul>
          {entry.children.map((child) => (
            <FileTreeBranch
              key={child.kind === "file" ? child.file.path : child.path}
              entry={child}
              activePath={activePath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
