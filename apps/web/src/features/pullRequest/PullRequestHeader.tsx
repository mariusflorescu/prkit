import type { PullRequestDetail } from "@prkit/contracts";
import { ArrowLeftIcon, ExternalLinkIcon, FileDiffIcon } from "lucide-react";
import type { Ref, ReactNode } from "react";

import { UserAvatar } from "~/components/UserAvatar";
import { pullRequestState } from "~/lib/pullRequestState";

import { relativeTime } from "./pullRequestPresentation";
import { PullRequestCheckoutButton } from "./PullRequestCheckoutButton";
import { PullRequestHeaderActions } from "./PullRequestHeaderActions";
import { PullRequestReadingAccount } from "./PullRequestReadingAccount";

export function PullRequestHeader({
  detail,
  sentinel,
  reviewAction,
  collapsed,
}: {
  detail: PullRequestDetail;
  sentinel: Ref<HTMLSpanElement>;
  reviewAction?: ReactNode;
  collapsed: boolean;
}) {
  const state = pullRequestState(detail);
  return (
    <header
      data-pr-expanded-header=""
      aria-hidden={collapsed}
      inert={collapsed}
      className="px-4 pt-2"
    >
      <div className="mb-2 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
        <h2 className="min-w-0 truncate">
          {/* The one way to GitHub; the arrow shows on hover and focus. */}
          <a
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            className="group/github inline-flex max-w-full items-center gap-1 rounded-sm hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="truncate">
              {detail.ref.owner}/{detail.ref.repo} #{detail.ref.number}
            </span>
            <ExternalLinkIcon
              aria-hidden
              className="size-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover/github:opacity-100 group-focus-visible/github:opacity-100 motion-reduce:transition-none"
            />
          </a>
        </h2>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-2xs ${state.tone}`}
        >
          <state.Icon aria-hidden className="size-3" />
          {state.label}
        </span>
        <div className="ml-auto">
          <PullRequestHeaderActions detail={detail} reviewAction={reviewAction} />
        </div>
      </div>
      <h1 className="relative min-w-0 text-base font-semibold leading-snug">
        {detail.title}
        <span
          ref={sentinel}
          data-pr-title-sentinel=""
          aria-hidden
          className="absolute bottom-0 left-0 h-px w-px"
        />
      </h1>
      <div data-pr-expanded-meta="" className="flex h-16 flex-col justify-center gap-2">
        <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground">
            <UserAvatar
              login={detail.author?.login ?? "ghost"}
              url={detail.author?.avatarUrl ?? null}
            />
            {detail.author?.login ?? "ghost"}
          </span>
          <span aria-hidden>·</span>
          <time dateTime={detail.updatedAt} title={new Date(detail.updatedAt).toLocaleString()}>
            updated {relativeTime(detail.updatedAt)}
          </time>
          <span className="ml-auto flex">
            <PullRequestReadingAccount detail={detail} />
          </span>
        </div>
        <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-muted-foreground/70">
            <span className="max-w-48 truncate" title={detail.baseBranch}>
              {detail.baseBranch}
            </span>
            <ArrowLeftIcon
              aria-label="receives changes from"
              className="size-3.5 shrink-0 opacity-60"
            />
            <span className="max-w-80 truncate" title={detail.headBranch}>
              {detail.headBranch}
            </span>
            <PullRequestCheckoutButton detail={detail} />
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-2 text-2xs tabular-nums">
            <span className="inline-flex items-center gap-1.5">
              <FileDiffIcon aria-hidden className="size-3.5" />
              {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
            </span>
            <span className="font-mono text-diff-addition-foreground">+{detail.additions}</span>
            <span className="font-mono text-diff-deletion-foreground">-{detail.deletions}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
