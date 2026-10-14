import { Skeleton } from "~/components/ui/skeleton";

/** The guide's outline: overview text, the flow diagram, then chapters. */
export function GuideSkeleton({ label = "Loading guide" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-8 px-6 py-6">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <Skeleton shape="card" className="h-44 w-full" />
      {[0, 1, 2].map((chapter) => (
        <div key={chapter} className="space-y-3">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-3.5 w-10/12" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton shape="card" className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}
