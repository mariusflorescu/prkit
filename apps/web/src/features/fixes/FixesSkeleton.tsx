import { Skeleton } from "~/components/ui/skeleton";

export function FixesSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading fixes"
      className="mx-auto w-full max-w-4xl space-y-4 px-6 pt-6"
    >
      <Skeleton className="h-5 w-64" />
      {[0, 1].map((index) => (
        <div key={index} className="space-y-2 rounded-lg border border-border px-4 py-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
