import type { TimelineReviewer } from "@prkit/contracts";
import { EyeIcon, TagIcon, UserRoundIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { eventFamily, type GroupedEvent } from "./conversationModel";
import { LabelChip } from "./LabelChip";
import { TimelineEventRow } from "./TimelineEventRow";
import { andList } from "./pullRequestPresentation";

const icons = {
  labels: <TagIcon className="size-3.5" />,
  reviewers: <EyeIcon className="size-3.5" />,
  assignees: <UserRoundIcon className="size-3.5" />,
};
const phrase = (verb: string, items: readonly ReactNode[]) =>
  items.length === 0
    ? []
    : [
        <Fragment key={verb}>
          {verb} {andList(items)}
        </Fragment>,
      ];
const name = (id: string, login: string) => (
  <span key={id} className="font-semibold text-foreground">
    {login}
  </span>
);
const reviewerName = (reviewer: TimelineReviewer | null) =>
  reviewer === null ? "ghost" : reviewer.kind === "team" ? reviewer.slug : reviewer.login;

type Events = readonly GroupedEvent[];
const sentences = {
  labels: (events: Events) => {
    const added = events.flatMap((event) =>
      event.kind === "labeled" ? [<LabelChip key={event.id} label={event.label} />] : [],
    );
    const removed = events.flatMap((event) =>
      event.kind === "unlabeled" ? [<LabelChip key={event.id} label={event.label} />] : [],
    );
    return (
      <>
        {andList([...phrase("added", added), ...phrase("removed", removed)])}{" "}
        {events.length === 1 ? "label" : "labels"}
      </>
    );
  },
  reviewers: (events: Events) => {
    const requested = events.flatMap((event) =>
      event.kind === "review-requested" ? [name(event.id, reviewerName(event.reviewer))] : [],
    );
    const removed = events.flatMap((event) =>
      event.kind === "review-request-removed" ? [name(event.id, reviewerName(event.reviewer))] : [],
    );
    return andList([
      ...phrase("requested a review from", requested),
      ...phrase("removed the request for review from", removed),
    ]);
  },
  assignees: (events: Events, actor: string) => {
    const [first] = events;
    if (events.length === 1 && first?.kind === "assigned" && first.assignee?.login === actor)
      return "self-assigned this";
    if (events.length === 1 && first?.kind === "unassigned" && first.assignee?.login === actor)
      return "removed their assignment";
    const assigned = events.flatMap((event) =>
      event.kind === "assigned" ? [name(event.id, event.assignee?.login ?? "ghost")] : [],
    );
    const unassigned = events.flatMap((event) =>
      event.kind === "unassigned" ? [name(event.id, event.assignee?.login ?? "ghost")] : [],
    );
    return andList([...phrase("assigned", assigned), ...phrase("unassigned", unassigned)]);
  },
};

/** A run of label, reviewer or assignee changes by one person: "added bug and ui labels". */
export function TimelineEventGroup({
  events,
}: {
  events: readonly [GroupedEvent, ...GroupedEvent[]];
}) {
  const [first] = events;
  const family = eventFamily[first.kind];
  return (
    <TimelineEventRow kind={family} icon={icons[family]} author={first.author} at={first.at}>
      {sentences[family](events, first.author?.login ?? "ghost")}
    </TimelineEventRow>
  );
}
