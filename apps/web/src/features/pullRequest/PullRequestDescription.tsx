import { pullRequestActionReason, type PullRequestDetail } from "@prkit/contracts";
import { GitPullRequestIcon, PencilIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { usePullRequestActions } from "./actionContext";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { relativeTime } from "./pullRequestPresentation";
import { TimelineMarker } from "./TimelineMarker";

/** The description, as the author's opening entry of the conversation. */
export function PullRequestDescription({ detail }: { detail: PullRequestDetail }) {
  const actions = usePullRequestActions();
  const reason = pullRequestActionReason(detail, "edit");
  return (
    <section aria-label="Description" data-timeline-kind="opened" className="relative pl-12">
      <TimelineMarker author={detail.author}>
        <GitPullRequestIcon className="size-3.5" />
      </TimelineMarker>
      <div className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="flex min-h-9 flex-wrap items-center gap-x-2 bg-muted/25 py-1 pr-1 pl-3 text-xs">
          <span className="font-semibold">{detail.author?.login ?? "ghost"}</span>
          <span className="text-muted-foreground">opened this pull request</span>
          <a
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            className="text-2xs text-muted-foreground hover:text-foreground hover:underline"
            title={new Date(detail.createdAt).toLocaleString()}
          >
            <time dateTime={detail.createdAt}>{relativeTime(detail.createdAt)}</time>
          </a>
          <Button
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            aria-label="Edit title and description"
            disabled={actions.pending || reason !== null}
            title={reason ?? "Edit title and description"}
            onClick={(event) => actions.show("edit", event.currentTarget)}
          >
            <PencilIcon />
            Edit
          </Button>
        </div>
        <div className="p-3">
          {detail.body ? (
            <PullRequestMarkdown body={detail.body} />
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              No description provided
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
