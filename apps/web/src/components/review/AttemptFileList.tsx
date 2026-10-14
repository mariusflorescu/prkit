import type { AttemptFile, AttemptId, DiffFile, PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { DiffWorkerPoolProvider, FileDiffCard } from "~/components/diff";
import { DiffSkeleton } from "~/components/diff/DiffSkeleton";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { attemptDiffQuery } from "~/rpc/queries";

import { AttemptFileRow } from "./AttemptFileRow";

/** The PR's changed files, each checked off as the agent reads it; any row opens its diff. */
export function AttemptFileList({
  reviewKey,
  attemptId,
  files,
  expected,
}: {
  reviewKey: PullRequestKey;
  attemptId: AttemptId;
  files: ReadonlyArray<AttemptFile>;
  /** How many rows to sketch while the code is checked out. */
  expected: number;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const diff = useQuery({ ...attemptDiffQuery(reviewKey, attemptId), enabled: opened.size > 0 });
  if (files.length === 0)
    return (
      <div aria-busy="true" aria-label="Loading changed files" className="space-y-3 px-1 py-2">
        {Array.from({ length: Math.min(Math.max(expected, 1), 6) }, (_, index) => (
          <Skeleton key={index} className="h-4 w-2/3" />
        ))}
      </div>
    );
  const byPath = new Map<string, DiffFile>(
    (diff.data?.files ?? []).map((file) => [file.path, file]),
  );
  return (
    <DiffWorkerPoolProvider>
      <ul aria-label="Changed files" className="px-1">
        {files.map((file) => {
          const snapshotFile = byPath.get(file.path);
          return (
            <AttemptFileRow
              key={file.path}
              file={file}
              open={opened.has(file.path)}
              onToggle={() =>
                setOpened((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(file.path)) next.add(file.path);
                  return next;
                })
              }
              diff={
                diff.isError ? (
                  <div
                    role="alert"
                    className="flex items-center gap-3 text-xs text-error-foreground"
                  >
                    <p>{diff.error.message}</p>
                    <Button size="compact" variant="outline" onClick={() => void diff.refetch()}>
                      Retry
                    </Button>
                  </div>
                ) : snapshotFile === undefined ? (
                  <DiffSkeleton />
                ) : (
                  <FileDiffCard file={snapshotFile} />
                )
              }
            />
          );
        })}
      </ul>
    </DiffWorkerPoolProvider>
  );
}
