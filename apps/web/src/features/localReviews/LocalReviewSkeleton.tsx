import { GuideSkeleton } from "~/components/review/GuideSkeleton";
import { Skeleton } from "~/components/ui/skeleton";

/** The header's two lines at their final height, then the guide's outline. */
export function LocalReviewSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading local review"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 space-y-2.5 border-b border-border px-(--workspace-gutter-start) pt-3.5 pb-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-3 w-80" />
      </div>
      <GuideSkeleton />
    </div>
  );
}
