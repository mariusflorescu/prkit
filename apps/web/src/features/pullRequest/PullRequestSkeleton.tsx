import { Skeleton } from "~/components/ui/skeleton";

export function PullRequestSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading pull request"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="space-y-3 px-4 py-3">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex gap-3 border-y border-border/60 px-4 py-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="space-y-6 px-4 py-5">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-24" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}
