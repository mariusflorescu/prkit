import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

export function ListSkeleton({
  label,
  rows = 7,
  kind = "inbox",
}: {
  label: string;
  rows?: number;
  kind?: "inbox" | "accounts";
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-1 px-3 py-3">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            "flex items-center gap-3 px-3 py-2.5",
            kind === "accounts" ? "min-h-24" : "min-h-14",
          )}
        >
          <Skeleton
            shape="pill"
            className={kind === "accounts" ? "size-9 shrink-0" : "size-4 shrink-0"}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={index % 2 === 0 ? "h-4 w-3/5" : "h-4 w-2/5"} />
            <Skeleton className="h-3 w-1/3" />
            {kind === "accounts" && <Skeleton className="h-3 w-1/2" />}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
