import { pullRequestKey, PullRequestRef } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { TabActionsSlot } from "~/components/TabActions";
import { ToolbarIconButton } from "~/components/ToolbarIconButton";
import { GuideTab } from "~/components/review";
import { PullRequestViewport } from "~/features/pullRequest/PullRequestViewport";
import { ReviewButton } from "~/features/reviewComments/ReviewButton";
import { PullRequestSkeleton } from "~/features/pullRequest/PullRequestSkeleton";
import { PullRequestConversation } from "~/features/pullRequest/PullRequestConversation";
import { PullRequestFiles } from "~/features/pullRequest/PullRequestFiles";
import { PullRequestChecksPopover } from "~/features/pullRequest/PullRequestChecksPopover";
import { readViewMemory, useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { FreshnessNotice } from "~/features/github/FreshnessNotice";
import { StackLinksProvider } from "~/features/stack/StackLinksProvider";
import { refreshPullRequestReads } from "~/features/github/pullRequestReads";
import { fixerFeedQuery, pullRequestDetailQuery } from "~/rpc/queries";
import { FixesTab } from "~/features/fixes/FixesTab";
import { useHasFixes } from "~/features/fixes/useHasFixes";
import { cn } from "~/lib/utils";

const route = getRouteApi("/pr/$host/$owner/$repo/$number");
const tabs = [
  { id: "conversation", title: "Conversation" },
  { id: "files", title: "Files" },
  { id: "guide", title: "Guide" },
  { id: "fixes", title: "Fixes" },
] as const;
export function PullRequestPage() {
  const params = route.useParams();
  const search = route.useSearch();
  const workspace = useWorkspace();
  const ref = Schema.decodeSync(PullRequestRef)({ ...params, number: Number(params.number) });
  const key = pullRequestKey(ref);
  const accountId =
    workspace.data?.open.find((row) => row.key === key)?.accountId ?? search.account;
  const memory = readViewMemory(key);
  const requested = search.tab ?? memory?.tab ?? "conversation";
  // Fixes shows once something went to the agent; a link to it before that opens Conversation.
  const hasFixes = useHasFixes(key);
  const tab = requested === "fixes" && hasFixes === false ? "conversation" : requested;
  const navigate = route.useNavigate();
  const client = useQueryClient();
  const options = pullRequestDetailQuery(key, accountId);
  const detail = useQuery({
    ...options,
    enabled: workspace.data !== undefined && !workspace.error,
  });
  const refresh = useMutation({
    mutationFn: () => refreshPullRequestReads(client, key, accountId),
  });
  const fixes = useQuery(fixerFeedQuery).data?.get(key)?.state ?? "idle";
  const synced = useRef<string | null>(null);
  const [tabActions, setTabActions] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    const identity = `${key}:${search.account}`;
    if (!workspace.data || workspace.error || synced.current === identity) return;
    synced.current = identity;
    workspace.ensure(key, search.account);
  }, [key, search.account, workspace]);
  useEffect(() => {
    useWorkspaceSession.getState().rememberTab(key, tab);
  }, [key, tab]);
  useEffect(() => {
    if (search.tab !== undefined && search.tab !== tab)
      void navigate({ search: (previous) => ({ ...previous, tab }), replace: true });
  }, [navigate, search.tab, tab]);
  const error = workspace.error ?? detail.error;
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader title={`${ref.owner}/${ref.repo} #${ref.number}`} />
        <div role="alert" className="m-6 rounded-lg border border-error/30 bg-error-surface p-6">
          <h1 className="text-sm font-medium">Couldn't load this pull request</h1>
          <p className="mt-2 text-sm text-error-foreground">{error.message}</p>
          <p className="mt-2 text-xs text-muted-foreground">Read through {accountId}</p>
          <div className="mt-4">
            <Button
              variant="outline"
              onClick={workspace.error ? workspace.retry : () => void detail.refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  if (!detail.isSuccess || (requested === "fixes" && hasFixes === undefined))
    return <PullRequestSkeleton />;
  return (
    <PullRequestViewport
      key={key}
      detail={detail.data}
      tab={tab}
      reviewAction={<ReviewButton detail={detail.data} />}
      tabs={
        <nav
          aria-label="Pull request tabs"
          className="flex h-11 min-w-0 items-center gap-1 overflow-x-auto border-y border-border/60 bg-background px-4 py-2"
        >
          <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {tabs
              .filter((item) => item.id !== "fixes" || hasFixes === true)
              .map((item) => (
                <Link
                  key={item.id}
                  to="/pr/$host/$owner/$repo/$number"
                  params={params}
                  search={{ account: accountId, tab: item.id }}
                  aria-current={tab === item.id ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === item.id
                      ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  aria-label={
                    item.id === "fixes" && fixes !== "idle"
                      ? `Fixes, ${fixes === "waiting" ? "ready for you" : "agent working"}`
                      : undefined
                  }
                >
                  {item.title}
                  {item.id === "fixes" && fixes !== "idle" && (
                    <span
                      aria-hidden="true"
                      data-fixes-state={fixes}
                      className={cn(
                        "ml-1.5 inline-block size-1.5 rounded-full align-middle",
                        fixes === "waiting" ? "bg-warning-foreground" : "bg-info-foreground",
                      )}
                    />
                  )}
                </Link>
              ))}
          </div>
          <PullRequestChecksPopover
            checks={detail.data.checks}
            rollup={detail.data.actions.checksState}
          />
          <span
            ref={setTabActions}
            className="ml-auto flex items-center gap-0.5 not-empty:mr-1 not-empty:border-r not-empty:border-border/60 not-empty:pr-1"
          />
          <ToolbarIconButton
            label="Refresh"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCwIcon
              className={cn(refresh.isPending && "animate-spin motion-reduce:animate-none")}
            />
          </ToolbarIconButton>
        </nav>
      }
    >
      <TabActionsSlot value={tabActions}>
        {refresh.error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-error/30 bg-error-surface p-3 text-xs text-error-foreground"
          >
            <p>{refresh.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => refresh.mutate()}>
              Retry
            </Button>
          </div>
        )}
        {detail.data.freshness.problem !== null && (
          <div className="border-b border-border/60 p-3">
            <FreshnessNotice
              problem={detail.data.freshness.problem}
              accountId={accountId}
              fetchedAt={detail.data.freshness.fetchedAt}
              retry={() => refresh.mutate()}
              retrying={refresh.isPending}
            />
          </div>
        )}
        {tab === "conversation" ? (
          <PullRequestConversation key={key} detail={detail.data} />
        ) : tab === "guide" ? (
          <StackLinksProvider detail={detail.data}>
            <GuideTab detail={detail.data} />
          </StackLinksProvider>
        ) : tab === "fixes" ? (
          <FixesTab key={key} detail={detail.data} />
        ) : (
          <PullRequestFiles key={key} detail={detail.data} />
        )}
      </TabActionsSlot>
    </PullRequestViewport>
  );
}
