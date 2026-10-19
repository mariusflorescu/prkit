import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";

/**
 * Says prkit can't read what a view follows now, in prkit's words, then what that leaves out
 * where it shows (`children`). prkit keeps trying by itself; Retry tries now.
 */
export function ReviewFeedNotice({
  label,
  message,
  retry,
  children,
}: {
  label: string;
  message: string;
  retry: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      aria-label={label}
      className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
    >
      <p className="min-w-0 flex-1 text-warning-foreground">
        {message} {children}
      </p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
