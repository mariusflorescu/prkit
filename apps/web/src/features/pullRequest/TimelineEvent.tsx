import type { TimelineReference } from "@prkit/contracts";
import {
  CheckCircle2Icon,
  CopyIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Link2Icon,
  PencilIcon,
} from "lucide-react";

import type { SingleEvent } from "./conversationModel";
import { TimelineEventRow } from "./TimelineEventRow";
import { TimelineMarker } from "./TimelineMarker";
import { relativeTime } from "./pullRequestPresentation";

const lifecycle = {
  opened: { Icon: GitPullRequestIcon, text: "opened this pull request" },
  merged: { Icon: GitMergeIcon, text: "merged this pull request" },
  closed: { Icon: GitPullRequestClosedIcon, text: "closed this pull request" },
  reopened: { Icon: GitPullRequestIcon, text: "reopened this pull request" },
  "ready-for-review": {
    Icon: CheckCircle2Icon,
    text: "marked this pull request as ready for review",
  },
  "converted-to-draft": {
    Icon: GitPullRequestDraftIcon,
    text: "marked this pull request as draft",
  },
};
const reference = (target: TimelineReference) => (
  <a href={target.url} target="_blank" rel="noreferrer" className="group/reference">
    <span className="font-semibold text-foreground group-hover/reference:underline">
      {target.title}
    </span>{" "}
    {target.crossRepository ? target.repository : ""}#{target.number}
  </a>
);

export function TimelineEvent({ event }: { event: SingleEvent }) {
  const row = { kind: event.kind, author: event.author, at: event.at };
  switch (event.kind) {
    case "commit":
      return (
        <li data-timeline-kind="commit" className="relative mb-5 pl-12">
          <TimelineMarker author={event.author}>
            <GitCommitHorizontalIcon className="size-3.5" />
          </TimelineMarker>
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`View commit ${event.sha.slice(0, 7)}`}
            className="group flex min-w-0 items-center gap-2.5 py-1.5 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-xs font-semibold group-hover:text-primary"
                title={event.title}
              >
                {event.title}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-3xs text-muted-foreground">
                <code>{event.sha.slice(0, 7)}</code>
                <time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                  {relativeTime(event.at)}
                </time>
              </div>
            </div>
            <span className="shrink-0 font-mono text-3xs">
              <span className="text-diff-addition-foreground">+{event.additions}</span>{" "}
              <span className="text-diff-deletion-foreground">-{event.deletions}</span>
            </span>
          </a>
        </li>
      );
    case "force-push":
      return (
        <TimelineEventRow {...row} icon={<GitBranchIcon className="size-3.5" />}>
          force-pushed the branch from{" "}
          <code>{event.beforeSha?.slice(0, 7) ?? "a deleted ref"}</code> to{" "}
          <code>{event.afterSha?.slice(0, 7) ?? "a deleted ref"}</code>
        </TimelineEventRow>
      );
    case "renamed":
      return (
        <TimelineEventRow {...row} icon={<PencilIcon className="size-3.5" />}>
          changed the title <del>{event.previousTitle}</del>{" "}
          <ins className="font-semibold text-foreground no-underline">{event.currentTitle}</ins>
        </TimelineEventRow>
      );
    case "base-changed":
      return (
        <TimelineEventRow {...row} icon={<GitCompareArrowsIcon className="size-3.5" />}>
          changed the base branch from{" "}
          <code className="font-semibold text-foreground">{event.previousBase}</code> to{" "}
          <code className="font-semibold text-foreground">{event.currentBase}</code>
        </TimelineEventRow>
      );
    case "cross-referenced":
      return (
        <TimelineEventRow {...row} icon={<Link2Icon className="size-3.5" />}>
          mentioned this in {reference(event.source)}
        </TimelineEventRow>
      );
    case "marked-as-duplicate":
      return (
        <TimelineEventRow {...row} icon={<CopyIcon className="size-3.5" />}>
          marked this as a duplicate
          {event.canonical && <> of {reference(event.canonical)}</>}
        </TimelineEventRow>
      );
    default: {
      const { Icon, text } = lifecycle[event.kind];
      return (
        <TimelineEventRow {...row} icon={<Icon className="size-3.5" />}>
          {text}
        </TimelineEventRow>
      );
    }
  }
}
