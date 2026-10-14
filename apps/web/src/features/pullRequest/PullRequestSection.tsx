import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PullRequestSection({
  title,
  label = title,
  open = true,
  children,
  meta,
}: {
  title: string;
  label?: string;
  open?: boolean;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <details open={open} className="group/section">
        <summary className="sticky top-0 z-10 flex cursor-pointer list-none items-center gap-1.5 bg-background px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <h2>{title}</h2>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 text-muted-foreground/60 group-open/section:rotate-90"
          />
          {meta && <span className="ml-auto text-2xs font-normal">{meta}</span>}
        </summary>
        <div className="px-4 pb-4">{children}</div>
      </details>
    </section>
  );
}
