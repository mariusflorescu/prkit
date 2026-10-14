import { Skeleton } from "~/components/ui/skeleton";

import { THEME_OPTIONS } from "./themeOptions";

/** Holds the cards' place, at their size, while the stored theme loads. */
export function ThemeCardsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading appearance"
      className="mt-4 grid grid-cols-3 gap-3"
    >
      {THEME_OPTIONS.map((option) => (
        <div
          key={option.value}
          className="flex flex-col gap-1.5 rounded-xl border border-border/70 p-2"
        >
          <Skeleton shape="card" className="h-35 w-full" />
          <Skeleton className="mx-auto h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
