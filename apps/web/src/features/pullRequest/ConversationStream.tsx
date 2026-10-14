import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUpIcon } from "lucide-react";

import { ListError } from "~/components/ListError";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { pullRequestTimelineQuery, reviewThreadsQuery } from "~/rpc/queries";
import { ConversationEntry } from "./ConversationEntry";
import { buildConversation } from "./conversationModel";
import { usePrViewStore } from "./prViewStore";

/** Everything after the description, oldest or newest first, on one rail. */
export function ConversationStream({ detail }: { detail: PullRequestDetail }) {
  const timeline = useQuery(pullRequestTimelineQuery(detail.key, detail.accountId));
  const threads = useQuery(reviewThreadsQuery(detail.key, detail.accountId));
  const { order, toggleOrder } = usePrViewStore();
  const items = buildConversation(
    detail,
    timeline.data?.events ?? [],
    threads.data?.threads ?? [],
    order,
  );
  return (
    <section aria-label="Activity" className="mt-4">
      <div className="mb-3 flex h-6 items-center justify-between gap-2 pl-12">
        <h2 className="text-xs font-medium text-muted-foreground">Activity</h2>
        <Button size="xs" variant="ghost-muted" onClick={toggleOrder}>
          <ArrowDownUpIcon />
          {order === "newest" ? "Newest first" : "Oldest first"}
        </Button>
      </div>
      {timeline.isError && (
        <div className="mb-4">
          <ListError
            title="Couldn't load commits and events"
            message={timeline.error.message}
            retry={() => void timeline.refetch()}
          />
        </div>
      )}
      {threads.isError && (
        <div className="mb-4">
          <ListError
            title="Couldn't load review threads"
            message={threads.error.message}
            retry={() => void threads.refetch()}
          />
        </div>
      )}
      {timeline.isPending || threads.isPending ? (
        <div aria-busy="true" aria-label="Loading activity" className="space-y-5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-5">
              <Skeleton className="size-7" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p role="status" className="py-2 pl-12 text-xs text-muted-foreground">
          No activity yet
        </p>
      ) : (
        <ol className="relative">
          <span aria-hidden className="absolute top-1 bottom-5 left-[15px] w-px bg-border/45" />
          {items.map((item) => (
            <ConversationEntry key={`${item.kind}:${item.id}`} item={item} detail={detail} />
          ))}
        </ol>
      )}
    </section>
  );
}
