import type { FixTarget, PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { pendingCommentsQuery, reviewThreadsQuery } from "~/rpc/queries";

import { runsOnCursor } from "./cursorFixes";
import { candidateId, fixCandidates } from "./fixCandidates";
import { ScriptAccessNotice } from "./ScriptAccessNotice";
import { SendToAgentFields } from "./SendToAgentFields";
import { useFixAgent } from "./useFixAgent";

/**
 * Hands comments to the PR's fix agent: which ones, anything else it should know,
 * and the agent. `only` preselects one comment (a draft's or thread's own button);
 * otherwise every draft is picked, and on your own PR every open thread whose last
 * comment isn't yours.
 */
export function SendToAgentForm({
  detail,
  only,
  onDone,
}: {
  detail: PullRequestDetail;
  only?: FixTarget;
  onDone: () => void;
}) {
  const login = detail.accountId.slice(detail.accountId.indexOf("/") + 1);
  const own = detail.author?.login === login;
  const pending = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const threads = useQuery(reviewThreadsQuery(detail.key, detail.accountId));
  const agent = useFixAgent(detail.key, null);
  if (pending.isPending || (threads.isPending && only?._tag !== "draft"))
    return (
      <div aria-busy="true" aria-label="Loading comments" className="mt-3 space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-4/5" />
      </div>
    );
  const loadError = pending.error ?? threads.error;
  if (loadError !== null || pending.data === undefined)
    return (
      <div role="alert" className="mt-3 flex items-center gap-2 text-xs text-error-foreground">
        <span>{loadError?.message ?? "Couldn't load the comments."}</span>
        <Button
          variant="outline"
          size="compact"
          onClick={() => {
            void pending.refetch();
            void threads.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  const candidates = fixCandidates(pending.data.comments, threads.data?.threads ?? [], login);
  if (candidates.length === 0)
    return (
      <div className="mt-3 space-y-2">
        <p role="status" className="text-xs text-muted-foreground">
          No comments to send. Comment on a line in Files first.
        </p>
        <ScriptAccessNotice detail={detail} cursor={runsOnCursor(agent.catalog, agent.selection)} />
      </div>
    );
  return (
    <SendToAgentFields
      detail={detail}
      candidates={candidates}
      own={own}
      initial={
        only !== undefined
          ? [candidateId(only)]
          : candidates
              .filter((candidate) => candidate.kind === "draft" || (own && candidate.awaitsReply))
              .map((candidate) => candidate.id)
      }
      onDone={onDone}
    />
  );
}
