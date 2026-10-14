import type { PullRequestAuthor } from "@prkit/contracts";
import type { ReactNode } from "react";
import { UserAvatar } from "~/components/UserAvatar";
import { cn } from "~/lib/utils";

/** The rail's mark for one entry; `compact` sits it level with a one-line event. */
export function TimelineMarker({
  author,
  compact = false,
  children,
}: {
  author: typeof PullRequestAuthor.Type | null;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "absolute left-0 z-10 flex size-8 items-center justify-center bg-background text-muted-foreground",
        compact ? "top-0" : "top-2",
      )}
    >
      {author ? <UserAvatar login={author.login} url={author.avatarUrl} size="medium" /> : children}
    </span>
  );
}
