import { type PullRequestSummary, pullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useStartGuide } from "~/components/review";
import { UserAvatar } from "~/components/UserAvatar";
import { Button } from "~/components/ui/button";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { pullRequestState } from "~/lib/pullRequestState";
import { cn } from "~/lib/utils";
import { reviewFeedQuery } from "~/rpc/queries";

import { InboxGuideMark } from "./InboxGuideMark";
import { InboxStackMark } from "./InboxStackMark";
import { relativeUpdatedTime } from "./inboxPresentation";

const CHECKS = {
  passing: { title: "Checks passing", tone: "bg-success" },
  failing: { title: "Checks failing", tone: "bg-error" },
  pending: { title: "Checks pending", tone: "bg-warning" },
};
const REVIEWS = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

export function InboxRow({
  entry,
  showAccount,
}: {
  entry: PullRequestSummary;
  showAccount: boolean;
}) {
  const workspace = useWorkspace();
  const guide = useStartGuide();
  const key = pullRequestKey(entry.ref);
  const review = useQuery({ ...reviewFeedQuery, select: (reviews) => reviews.get(key) }).data;
  const canGenerate =
    entry.state === "open" &&
    (review === undefined ||
      (review.latestRevision === null && (review.status === "failed" || review.status === "done")));
  const { Icon, label, tone } = pullRequestState(entry);
  const checks = entry.checks === null ? null : CHECKS[entry.checks];
  return (
    // The size column and the Generate guide action share the last grid column, so it is
    // as wide as the wider of the two and the action replaces the sizes without a shift.
    <li className="group/row grid grid-cols-[minmax(0,1fr)_auto]">
      <Link
        to="/pr/$host/$owner/$repo/$number"
        params={{
          host: entry.ref.host,
          owner: entry.ref.owner,
          repo: entry.ref.repo,
          number: String(entry.ref.number),
        }}
        search={{ account: entry.accountId, tab: "conversation" }}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          workspace.open(pullRequestKey(entry.ref), entry.accountId);
        }}
        data-account={entry.accountId}
        data-repository={`${entry.ref.owner}/${entry.ref.repo}`}
        data-pr-number={entry.ref.number}
        className="col-span-full row-start-1 grid min-h-14 grid-cols-subgrid items-center rounded-md px-3 py-2.5 text-left group-hover/row:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex w-4 shrink-0 flex-col items-center gap-1.5">
            <Icon aria-label={`${label} pull request`} className={cn("size-4", tone)} />
            {checks && (
              <span
                role="img"
                aria-label={checks.title}
                title={checks.title}
                className={cn("size-1.5 rounded-full", checks.tone)}
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                #{entry.ref.number}
              </span>
              <span className="min-w-0 truncate text-sm">{entry.title}</span>
              <InboxStackMark stack={entry.stack} />
              <InboxGuideMark review={review} />
              {entry.reviewDecision && (
                <span className="hidden shrink-0 text-2xs text-muted-foreground lg:inline">
                  {REVIEWS[entry.reviewDecision]}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
              <UserAvatar
                login={entry.author?.login ?? "ghost"}
                url={entry.author?.avatarUrl ?? null}
              />
              <span className="shrink-0">{entry.author?.login ?? "ghost"}</span>
              <span className="min-w-0 truncate">
                {entry.ref.owner}/{entry.ref.repo}
              </span>
              {showAccount && (
                <span
                  title={entry.accountId}
                  className="shrink-0 text-3xs text-muted-foreground/70"
                >
                  {entry.accountId.slice(entry.accountId.indexOf("/") + 1)}
                </span>
              )}
              {entry.labels.slice(0, 2).map((label) => (
                <span
                  key={label.name}
                  className="hidden max-w-32 truncate rounded bg-muted px-1 text-3xs xl:inline"
                >
                  {label.name}
                </span>
              ))}
              {entry.labels.length > 2 && (
                <span className="hidden shrink-0 text-3xs xl:inline">
                  +{entry.labels.length - 2}
                </span>
              )}
            </span>
          </span>
        </span>
        <span
          className={cn(
            "flex flex-col items-end pl-2 text-2xs tabular-nums",
            canGenerate &&
              "transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none",
          )}
        >
          <span className="flex h-5 items-center gap-1.5 font-mono">
            <span className="text-diff-addition-foreground">+{entry.additions}</span>
            <span className="text-diff-deletion-foreground">-{entry.deletions}</span>
          </span>
          <time
            dateTime={entry.updatedAt}
            title={entry.updatedAt}
            className="mt-0.5 flex min-h-3.5 items-center whitespace-nowrap text-muted-foreground"
          >
            {relativeUpdatedTime(entry.updatedAt)}
          </time>
        </span>
      </Link>
      {canGenerate && (
        <span className="pointer-events-none col-start-2 row-start-1 mr-3 ml-2 self-center justify-self-end opacity-0 transition-opacity duration-150 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 motion-reduce:transition-none">
          <Button
            variant="outline"
            size="compact"
            disabled={guide.pending}
            aria-label={`Generate guide for ${entry.ref.owner}/${entry.ref.repo} #${entry.ref.number}`}
            onClick={() => guide.start(key, entry.accountId, false)}
          >
            Generate guide
          </Button>
        </span>
      )}
    </li>
  );
}
