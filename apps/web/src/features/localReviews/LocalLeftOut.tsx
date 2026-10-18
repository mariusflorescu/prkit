import type { LocalLeftOut as LeftOutFile } from "@prkit/contracts";

import { LEFT_OUT_REASONS } from "./localPresentation";

/** Files the snapshot shows as committed, or leaves out when new, and why, folded by default. */
export function LocalLeftOut({ files }: { files: ReadonlyArray<LeftOutFile> }) {
  return (
    <details className="group shrink-0 border-b border-border/60 pr-(--workspace-gutter-end) pl-(--workspace-gutter-start) text-xs text-muted-foreground">
      <summary className="flex h-8 cursor-pointer items-center rounded-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">
        {files.length} {files.length === 1 ? "file" : "files"} left out of the snapshot
      </summary>
      <ul aria-label="Files left out" className="space-y-1 pb-2.5">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 gap-2">
            <span className="min-w-0 truncate font-mono text-foreground" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0">{LEFT_OUT_REASONS[file.reason]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
