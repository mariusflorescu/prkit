import type { PullRequestDetail } from "@prkit/contracts";
import { ArrowLeftIcon, ExternalLinkIcon, FileDiffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { UserAvatar } from "~/components/UserAvatar";
import { pullRequestState } from "~/lib/pullRequestState";
import { relativeTime } from "./pullRequestPresentation";
import { PullRequestHeaderActions } from "./PullRequestHeaderActions";

export function PullRequestCompactHeader({
  detail,
  collapsed,
  reviewAction,
}: {
  detail: PullRequestDetail;
  collapsed: boolean;
  reviewAction?: ReactNode;
}) {
  const state = pullRequestState(detail);
  return (
    <header
      data-pr-compact-header=""
      data-collapse-compact=""
      aria-label="Compact pull request header"
      aria-hidden={!collapsed}
      inert={!collapsed}
      className="h-16 bg-background px-4 py-2"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <a
          href={detail.url}
          target="_blank"
          rel="noreferrer"
          className="group/github inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open #${detail.ref.number} on GitHub`}
        >
          <span className="tabular-nums">#{detail.ref.number}</span>
          <ExternalLinkIcon
            aria-hidden
            className="size-3 opacity-0 transition-opacity duration-150 group-hover/github:opacity-100 group-focus-visible/github:opacity-100 motion-reduce:transition-none"
          />
        </a>
        <p className="min-w-0 flex-1 truncate font-medium" title={detail.title}>
          {detail.title}
        </p>
        <span className={`inline-flex shrink-0 items-center gap-1 text-2xs ${state.tone}`}>
          <state.Icon aria-hidden className="size-3" />
          {state.label}
        </span>
        <PullRequestHeaderActions detail={detail} reviewAction={reviewAction} />
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <UserAvatar
          login={detail.author?.login ?? "ghost"}
          url={detail.author?.avatarUrl ?? null}
        />
        <time dateTime={detail.updatedAt} className="shrink-0">
          {relativeTime(detail.updatedAt)}
        </time>
        <span aria-hidden className="text-border">
          |
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-muted-foreground/70">
          <span className="max-w-32 truncate" title={detail.baseBranch}>
            {detail.baseBranch}
          </span>
          <ArrowLeftIcon aria-label="receives changes from" className="size-3 shrink-0" />
          <span className="truncate" title={detail.headBranch}>
            {detail.headBranch}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
          <FileDiffIcon aria-hidden className="size-3" />
          <span aria-label={`${detail.changedFiles} changed files`}>{detail.changedFiles}</span>
          <span className="font-mono text-diff-addition-foreground">+{detail.additions}</span>
          <span className="font-mono text-diff-deletion-foreground">-{detail.deletions}</span>
        </span>
      </div>
    </header>
  );
}
