import { ExternalLinkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ConversationComment } from "./conversationModel";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { relativeTime, reviewStates } from "./pullRequestPresentation";

/** One comment or review as a card. Its author's avatar sits on the conversation rail. */
export function PullRequestComment({ item }: { item: ConversationComment }) {
  return (
    <article
      data-timeline-kind={item.kind}
      aria-label={`${item.kind === "review" ? "Review" : "Comment"} by ${item.author?.login ?? "ghost"}`}
      className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-2 bg-muted/25 px-3 py-2 text-xs">
        <span className="font-semibold">{item.author?.login ?? "ghost"}</span>
        {item.kind === "review" && (
          <span
            className={cn(
              "text-2xs",
              item.state === "APPROVED"
                ? "text-success-foreground"
                : item.state === "CHANGES_REQUESTED"
                  ? "text-error-foreground"
                  : "text-muted-foreground",
            )}
          >
            {reviewStates[item.state ?? ""] ?? "Reviewed"}
          </span>
        )}
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground hover:underline"
          title={new Date(item.at).toLocaleString()}
        >
          <time dateTime={item.at}>{relativeTime(item.at)}</time>
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      </div>
      {item.body ? (
        <div className="p-3">
          <PullRequestMarkdown body={item.body} />
        </div>
      ) : (
        <p className="p-3 text-xs text-muted-foreground">Review submitted without a message</p>
      )}
    </article>
  );
}
