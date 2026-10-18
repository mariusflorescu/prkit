import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type InboxEntry, type OpenPullRequest, refFromKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useReviewWatch } from "~/components/review/useReviewWatch";
import { guideProgress } from "~/components/review/progressModel";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { cn } from "~/lib/utils";
import { pullRequestDetailQuery, pullRequestStatusQuery, reviewQuery } from "~/rpc/queries";
import { TabCloseButton } from "./TabCloseButton";
import { TabContextMenu } from "./TabContextMenu";
import { TabStateIcon } from "./TabStateIcon";
import { TabTooltip } from "./TabTooltip";
import { tabSurface } from "./tabSurface";

export function PullRequestWorkspaceTab({
  row,
  entry,
  active,
}: {
  row: OpenPullRequest;
  entry: InboxEntry | undefined;
  active: boolean;
}) {
  const workspace = useWorkspace();
  // A background tab never reads its PR: the watcher's fingerprint carries its state,
  // and the detail is shown only if the PR page already read it.
  const detail = useQuery({ ...pullRequestDetailQuery(row.key, row.accountId), enabled: false });
  const statuses = useQuery(pullRequestStatusQuery);
  useReviewWatch(row.key);
  const review = useQuery(reviewQuery(row.key));
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.key });
  const ref = refFromKey(row.key);
  if (!ref) return null;
  const data = statuses.data?.get(`${row.accountId}:${row.key}`) ?? detail.data ?? entry;
  const name = `${ref.owner}/${ref.repo} #${ref.number}`;
  const status = review.data?.review?.status;
  const running = status?._tag === "preparing" || status?._tag === "writing";
  const attempt = review.data?.attempt;
  const progress = running && attempt != null ? guideProgress(attempt) : null;
  return (
    <TabContextMenu row={row}>
      <div
        ref={setNodeRef}
        {...listeners}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        data-active-tab={active}
        className={cn(
          "group/tab flex h-6 shrink-0 touch-none items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs [-webkit-app-region:no-drag]",
          tabSurface(active),
          isDragging && "relative z-10",
        )}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const rows = workspace.data?.open ?? [];
          const index = rows.findIndex((candidate) => candidate.key === row.key);
          const to = index + (event.key === "ArrowLeft" ? -1 : 1);
          if (to < 0 || to >= rows.length) return;
          const keys = rows.map((candidate) => candidate.key).filter((key) => key !== row.key);
          keys.splice(to, 0, row.key);
          workspace.send({ kind: "reorder", keys });
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            workspace.close(row.key);
          }
        }}
      >
        <TabCloseButton label={`Close ${name}`} onClose={() => workspace.close(row.key)}>
          <TabStateIcon
            data={data}
            review={review.data}
            conflicting={detail.data?.mergeability === "conflicting"}
          />
        </TabCloseButton>
        <TabTooltip
          label={`#${ref.number}`}
          details={
            <>
              <p>{data?.title ?? name}</p>
              <p className="text-muted-foreground">
                {ref.owner}/{ref.repo} · {row.accountId}
              </p>
              {running && (
                <p data-tab-guide-progress="">
                  {(review.data?.revisions.length ?? 0) > 0 ? "Updating guide" : "Writing guide"}
                  {progress !== null && ` · ${progress.short}`}
                </p>
              )}
              {status?._tag === "failed" && <p>Guide failed · {status.message}</p>}
              {status?._tag === "watching" && <p>Watching for new commits</p>}
              {status?._tag === "done" && <p>Review done · {status.reason}</p>}
              {detail.isPending && !data && (
                <span aria-busy="true" aria-label={`Loading ${name}`}>
                  <Skeleton className="h-3 w-36" />
                </span>
              )}
              {review.isError && (
                <div role="alert">
                  <p>{review.error.message}</p>
                  <Button size="sm" variant="outline" onClick={() => void review.refetch()}>
                    Retry
                  </Button>
                </div>
              )}
            </>
          }
        >
          <a
            href={`/pr/${ref.host}/${ref.owner}/${ref.repo}/${ref.number}?account=${encodeURIComponent(row.accountId)}`}
            aria-label={`Open ${name}${data ? ` ${data.title}` : ""}`}
            aria-current={active ? "page" : undefined}
            data-open-pr={row.key}
            data-account={row.accountId}
            className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              workspace.activate(row.key);
            }}
          >
            #{ref.number}
          </a>
        </TabTooltip>
      </div>
    </TabContextMenu>
  );
}
