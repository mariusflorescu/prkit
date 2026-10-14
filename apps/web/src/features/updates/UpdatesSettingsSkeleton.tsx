import { Skeleton } from "~/components/ui/skeleton";

/** Holds the section's rows, at their size, while the shell answers. */
export function UpdatesSettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading updates" className="mt-4 flex flex-col gap-4">
      <Skeleton className="h-4 w-40" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-7 w-36" />
      </div>
      <Skeleton className="h-3 w-80" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-32" />
      </div>
    </div>
  );
}
