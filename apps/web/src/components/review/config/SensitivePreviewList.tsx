import { SCOPE_LABELS } from "@prkit/contracts";

import { Skeleton } from "~/components/ui/skeleton";
import { LoadProblem } from "~/features/settings/guides/LoadProblem";

import type { GuideConfigPreview } from "./useGuideConfigPreview";

/** The changed files the saved look-closely paths match now, with the path that matched. */
export function SensitivePreviewList({ preview }: { preview: GuideConfigPreview }) {
  const { files, sensitive } = preview;
  if (files.isError)
    return (
      <LoadProblem
        title="Couldn't preview the files"
        message={files.error.message}
        retry={() => void files.refetch()}
      />
    );
  if (sensitive === null)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the look-closely preview"
        className="space-y-1.5"
      >
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    );
  const truncated = files.data !== undefined && files.data.changedFiles > files.data.files.length;
  return (
    <div className="space-y-1">
      {sensitive.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          No changed file matches these paths.
        </p>
      ) : (
        <ul aria-label="Files that match look-closely paths" className="divide-y divide-border/60">
          {sensitive.map((entry) => (
            <li key={entry.path} className="space-y-0.5 py-1.5 text-xs">
              <p>
                <span className="break-all font-mono">{entry.path}</span>
                <span className="text-muted-foreground">
                  {" · "}
                  <code>{entry.rule.pattern}</code> ({SCOPE_LABELS[entry.rule.scope]})
                  {entry.rule.path === entry.path
                    ? ""
                    : `, matched its old path ${entry.rule.path}`}
                </span>
              </p>
              {entry.skippedByIgnore && (
                <p className="text-[11px] text-muted-foreground">
                  Your ignore rules skip it, so the guide won&apos;t look at it.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {truncated && files.data !== undefined && (
        <p className="text-[11px] text-muted-foreground">
          Preview of the first {files.data.files.length} of {files.data.changedFiles} files.
        </p>
      )}
    </div>
  );
}
