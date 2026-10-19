import type { OpenLocalReview } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderGit2Icon } from "lucide-react";

import { guideProgress } from "~/components/review/progressModel";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  isRunning,
  LOCAL_STATUS_WORDS,
  localTitle,
} from "~/features/localReviews/localPresentation";
import { useLocalReviewWatch } from "~/features/localReviews/useLocalReviewWatch";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { cn } from "~/lib/utils";
import { localReviewQuery } from "~/rpc/queries";

import { TabCloseButton } from "./TabCloseButton";
import { TabProgressRing } from "./TabProgressRing";
import { TabTooltip } from "./TabTooltip";
import { tabSurface } from "./tabSurface";

/**
 * A local review after the PR tabs: the folder and branch, never a PR number, with the same
 * progress ring while a guide is written. It has no PR menu and is not reordered among PRs.
 */
export function LocalReviewWorkspaceTab({
  row,
  active,
}: {
  row: OpenLocalReview;
  active: boolean;
}) {
  const workspace = useWorkspace();
  const { problem, retry } = useLocalReviewWatch(row.key);
  const snapshot = useQuery(localReviewQuery(row.key));
  const review = snapshot.data?.review ?? null;
  const title = review === null ? "Local review" : localTitle(review.source);
  // While prkit can't read the review, its last state can't be vouched for: no ring, a warning.
  const running = problem === null && review !== null && isRunning(review.status);
  const attempt = snapshot.data?.attempt ?? null;
  const progress = running && attempt !== null ? guideProgress(attempt) : null;
  const warning = review?.status._tag === "failed" || problem !== null || snapshot.isError;
  return (
    <div
      data-active-tab={active}
      data-local-tab={row.key}
      className={cn(
        "group/tab flex h-6 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs [-webkit-app-region:no-drag]",
        tabSurface(active),
      )}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          workspace.closeLocal(row.key);
        }
      }}
    >
      <TabCloseButton label={`Close ${title}`} onClose={() => workspace.closeLocal(row.key)}>
        <span
          aria-hidden="true"
          data-review-status={review?.status._tag ?? "none"}
          className="relative flex size-3 items-center justify-center"
        >
          {progress !== null ? (
            <TabProgressRing filled={Math.round(progress.fraction * 100)} />
          ) : (
            <FolderGit2Icon className="size-3 text-muted-foreground" />
          )}
          {warning && (
            <span
              data-guide-warning=""
              className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-warning-foreground"
            />
          )}
        </span>
      </TabCloseButton>
      <TabTooltip
        label={title}
        details={
          <>
            {review !== null && (
              <>
                <p className="break-all font-mono text-muted-foreground">{review.source.path}</p>
                {problem === null && (
                  <p data-tab-guide-progress={running ? "" : undefined}>
                    {LOCAL_STATUS_WORDS[review.status._tag]}
                    {progress !== null && ` · ${progress.short}`}
                    {review.status._tag === "failed" && ` · ${review.status.message}`}
                  </p>
                )}
              </>
            )}
            {problem !== null && (
              <div role="alert">
                <p>{problem}</p>
                <Button size="sm" variant="outline" onClick={retry}>
                  Retry
                </Button>
              </div>
            )}
            {snapshot.isError && (
              <div role="alert">
                <p>{snapshot.error.message}</p>
                <Button size="sm" variant="outline" onClick={() => void snapshot.refetch()}>
                  Retry
                </Button>
              </div>
            )}
          </>
        }
      >
        <Link
          to="/local/$key"
          params={{ key: row.key }}
          aria-label={`Open the local review of ${title}`}
          aria-current={active ? "page" : undefined}
          className="block max-w-44 cursor-pointer truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {snapshot.isPending ? (
            <span aria-busy="true" aria-label="Loading local review">
              <Skeleton className="h-3 w-20" />
            </span>
          ) : (
            title
          )}
        </Link>
      </TabTooltip>
    </div>
  );
}
