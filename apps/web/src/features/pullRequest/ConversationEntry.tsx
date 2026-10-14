import type { PullRequestDetail } from "@prkit/contracts";
import { MessageSquareIcon } from "lucide-react";

import { ReviewThreadCard } from "~/features/reviewComments/ReviewThreadCard";
import type { ConversationItem } from "./conversationModel";
import { PullRequestComment } from "./PullRequestComment";
import { TimelineEvent } from "./TimelineEvent";
import { TimelineEventGroup } from "./TimelineEventGroup";
import { TimelineMarker } from "./TimelineMarker";

export function ConversationEntry({
  item,
  detail,
}: {
  item: ConversationItem;
  detail: PullRequestDetail;
}) {
  if (item.kind === "event") return <TimelineEvent event={item.event} />;
  if (item.kind === "group") return <TimelineEventGroup events={item.events} />;
  return (
    <li className="relative mb-5 pl-12">
      <TimelineMarker
        author={
          item.kind === "comment" ? item.comment.author : (item.thread.comments[0]?.author ?? null)
        }
      >
        <MessageSquareIcon className="size-3.5" />
      </TimelineMarker>
      {item.kind === "comment" ? (
        <PullRequestComment item={item.comment} />
      ) : (
        <ReviewThreadCard thread={item.thread} pr={detail} context inset={false} />
      )}
    </li>
  );
}
