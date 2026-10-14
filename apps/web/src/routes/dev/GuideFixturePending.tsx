import { DiffSkeleton } from "~/components/diff/DiffSkeleton";

export function GuideFixturePending() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 p-8"
      role="status"
      aria-label="Loading guide fixture"
      aria-busy="true"
    >
      <div className="h-8 w-60 rounded-md bg-border" />
      <div className="grid gap-6 lg:grid-cols-2">
        <DiffSkeleton />
        <div className="h-60 rounded-lg bg-border" />
      </div>
      <DiffSkeleton />
    </div>
  );
}
