import type { PullRequestDetail, PullRequestTimelineEvent, ReviewThread } from "@prkit/contracts";

export type ConversationComment = PullRequestDetail["conversation"][number];
/** Label, reviewer and assignee changes. Like GitHub, a run of them by one person is one row. */
export const eventFamily = {
  labeled: "labels",
  unlabeled: "labels",
  "review-requested": "reviewers",
  "review-request-removed": "reviewers",
  assigned: "assignees",
  unassigned: "assignees",
} as const;
export type GroupedEvent = Extract<PullRequestTimelineEvent, { kind: keyof typeof eventFamily }>;
export type SingleEvent = Exclude<PullRequestTimelineEvent, GroupedEvent>;
/** How far apart, at most, the first and last change of one row are. */
const GROUP_WINDOW_MS = 5 * 60_000;

export type ConversationItem =
  | { kind: "comment"; id: string; at: string; comment: ConversationComment }
  | { kind: "thread"; id: string; at: string; thread: ReviewThread }
  | { kind: "event"; id: string; at: string; event: SingleEvent }
  | { kind: "group"; id: string; at: string; events: readonly [GroupedEvent, ...GroupedEvent[]] };

const isGrouped = (event: PullRequestTimelineEvent): event is GroupedEvent =>
  Object.hasOwn(eventFamily, event.kind);
type Group = Extract<ConversationItem, { kind: "group" }>;
const joins = (group: Group, item: Group) => {
  const [first] = group.events;
  const [next] = item.events;
  return (
    eventFamily[first.kind] === eventFamily[next.kind] &&
    first.author?.login === next.author?.login &&
    Date.parse(next.at) - Date.parse(first.at) <= GROUP_WINDOW_MS
  );
};

/**
 * Comments, reviews, review threads, commits and events in one chronological list.
 * A review comment that a loaded thread already holds is shown inside that thread only.
 * GitHub gives the two reads different ids for it (REST database id, GraphQL node id),
 * so the shared identity is its URL.
 */
export const buildConversation = (
  detail: PullRequestDetail,
  events: readonly PullRequestTimelineEvent[],
  threads: readonly ReviewThread[],
  order: "newest" | "oldest",
): ConversationItem[] => {
  const inThreads = new Set(
    threads.flatMap((thread) => thread.comments.map((comment) => comment.url)),
  );
  const items: ConversationItem[] = [
    ...detail.conversation
      .filter((comment) => comment.kind !== "review-comment" || !inThreads.has(comment.url))
      .map((comment) => ({ kind: "comment" as const, id: comment.id, at: comment.at, comment })),
    ...threads.map((thread) => ({
      kind: "thread" as const,
      id: thread.id,
      at: thread.comments[0]?.createdAt ?? "",
      thread,
    })),
    ...events.map((event): ConversationItem =>
      isGrouped(event)
        ? { kind: "group", id: event.id, at: event.at, events: [event] }
        : { kind: "event", id: event.id, at: event.at, event },
    ),
  ].toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const rows: ConversationItem[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (last?.kind === "group" && item.kind === "group" && joins(last, item))
      rows[rows.length - 1] = { ...last, events: [...last.events, ...item.events] };
    else rows.push(item);
  }
  return order === "newest" ? rows.toReversed() : rows;
};
