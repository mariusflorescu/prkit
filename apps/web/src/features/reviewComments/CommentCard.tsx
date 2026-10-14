import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The frame every comment, draft and composer sits in under a diff line. Pointer
 * presses stay inside it so they never start a line selection in the diff.
 */
export function CommentCard({
  draft = false,
  inset = true,
  label,
  children,
}: {
  draft?: boolean;
  /** Indented under a diff line; flush where it sits in a page's own list. */
  inset?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <article
      aria-label={label}
      data-comment-card={draft ? "draft" : "thread"}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "rounded-lg border bg-background p-3 font-sans text-sm text-foreground shadow-xs",
        inset && "mx-3 my-2 max-w-3xl",
        draft ? "border-dashed border-warning/50" : "border-border/70",
      )}
    >
      {children}
    </article>
  );
}
