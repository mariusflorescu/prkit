import type { PullRequestAuthor } from "@prkit/contracts";
import type { ReactNode } from "react";

import { UserAvatar } from "~/components/UserAvatar";
import { personName } from "~/features/github/personName";
import { TimelineMarker } from "./TimelineMarker";
import { relativeTime } from "./pullRequestPresentation";

/** One line on the rail, like GitHub's: the event's icon, who did it, what they did, and when. */
export function TimelineEventRow({
  kind,
  icon,
  author,
  at,
  children,
}: {
  kind: string;
  icon: ReactNode;
  author: typeof PullRequestAuthor.Type | null;
  at: string;
  children: ReactNode;
}) {
  return (
    <li data-timeline-kind={kind} className="relative mb-2 pl-12">
      <TimelineMarker author={null} compact>
        {icon}
      </TimelineMarker>
      <p className="py-1.5 text-xs leading-5 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 align-top font-semibold text-foreground">
          <span className="flex h-5 items-center">
            <UserAvatar login={personName(author)} url={author?.avatarUrl ?? null} />
          </span>
          {personName(author)}
        </span>{" "}
        {children}{" "}
        <time dateTime={at} title={new Date(at).toLocaleString()} className="whitespace-nowrap">
          {relativeTime(at)}
        </time>
      </p>
    </li>
  );
}
