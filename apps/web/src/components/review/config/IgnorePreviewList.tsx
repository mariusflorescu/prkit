import { Skeleton } from "~/components/ui/skeleton";
import { LoadProblem } from "~/features/settings/guides/LoadProblem";

import { FilePreviewRow } from "./FilePreviewRow";
import type { GuideConfigPreview } from "./useGuideConfigPreview";

/** Every changed file with what the saved rules decide for it now. */
export function IgnorePreviewList({ preview }: { preview: GuideConfigPreview }) {
  const { files, decisions, skipped } = preview;
  if (files.isError)
    return (
      <LoadProblem
        title="Couldn't preview the files"
        message={files.error.message}
        retry={() => void files.refetch()}
      />
    );
  if (decisions === null)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the file preview"
        className="space-y-1.5"
      >
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  if (decisions.length === 0)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        This pull request changes no files.
      </p>
    );
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {decisions.length - (skipped?.length ?? 0)} reviewed, {skipped?.length ?? 0} skipped
        {files.data !== undefined && files.data.changedFiles > files.data.files.length
          ? `, preview of the first ${files.data.files.length} of ${files.data.changedFiles} files`
          : ""}
      </p>
      <ul aria-label="Files and the rules that decide them" className="divide-y divide-border/60">
        {decisions.map((entry) => (
          <FilePreviewRow key={entry.file.path} decision={entry.decision} />
        ))}
      </ul>
    </div>
  );
}
