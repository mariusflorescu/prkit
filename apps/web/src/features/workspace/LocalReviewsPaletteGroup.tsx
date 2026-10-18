import type { LocalReviewEntry, LocalReviewKey } from "@prkit/contracts";
import { FolderGit2Icon } from "lucide-react";

import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";
import { LOCAL_STATUS_WORDS, localTitle } from "~/features/localReviews/localPresentation";

/** The palette's "Local reviews": each one's folder and branch, its path, and its state. */
export function LocalReviewsPaletteGroup({
  entries,
  open,
  pending,
  error,
  onRetry,
  onChoose,
}: {
  entries: ReadonlyArray<LocalReviewEntry>;
  /** The keys with a tab in the strip. */
  open: ReadonlySet<LocalReviewKey>;
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
  onChoose: (key: LocalReviewKey) => void;
}) {
  if (pending) return <ListSkeleton label="Loading local reviews" rows={1} />;
  if (error !== null)
    return (
      <div role="alert" className="space-y-2 p-3 text-xs text-error-foreground">
        <p>{error.message}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  if (entries.length === 0) return null;
  return (
    <section aria-label="Local reviews" className="mt-1">
      <h2 className="px-3 pt-2 pb-1 text-2xs font-medium text-muted-foreground">Local reviews</h2>
      {entries.map((entry) => (
        <button
          type="button"
          data-command-result=""
          key={entry.key}
          onClick={() => onChoose(entry.key)}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        >
          <FolderGit2Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{localTitle(entry.source)}</span>
            <span className="mt-0.5 block truncate font-mono text-2xs text-muted-foreground">
              {entry.source.path}
            </span>
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {open.has(entry.key) ? "Open" : LOCAL_STATUS_WORDS[entry.status]}
          </span>
        </button>
      ))}
    </section>
  );
}
