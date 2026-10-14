import { AUTO_RESOLVE_LIMIT, FIXER_BUSY, type PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { ListError } from "~/components/ListError";
import { fixerQuery } from "~/rpc/queries";

import { FixesHeader } from "./FixesHeader";
import { FixesSkeleton } from "./FixesSkeleton";
import { turnsListingScripts } from "./fixPresentation";
import { FixTurnCard } from "./FixTurnCard";
import { ResolveConflictsButton } from "./ResolveConflictsButton";
import { useFixerWatch } from "./useFixerWatch";

/** The PR view's Fixes tab: the fix agent's queue, newest first. */
export function FixesTab({ detail }: { detail: PullRequestDetail }) {
  useFixerWatch(detail.key);
  const fixer = useQuery(fixerQuery(detail.key));
  if (fixer.isPending) return <FixesSkeleton />;
  if (fixer.isError)
    return (
      <div className="mx-auto w-full max-w-4xl px-6 pt-6">
        <ListError
          title="Couldn't load the fix agent"
          message={fixer.error.message}
          retry={() => void fixer.refetch()}
        />
      </div>
    );
  const snapshot = fixer.data;
  // The tab shows only once the PR has a turn, so an empty snapshot is a stale copy
  // the watch is about to replace.
  if (snapshot.turns.length === 0) return <FixesSkeleton />;
  const current = snapshot.turns.find((turn) => turn.status._tag !== "queued");
  const listingScripts = turnsListingScripts(snapshot.turns);
  const busy = snapshot.turns.some((turn) => FIXER_BUSY.includes(turn.status._tag));
  const resolving = snapshot.turns.some(
    (turn) =>
      turn.work._tag === "conflicts" &&
      (turn.status._tag === "queued" || FIXER_BUSY.includes(turn.status._tag)),
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-6 pt-6 pb-10">
      <FixesHeader detail={detail} snapshot={snapshot} />
      {detail.mergeability === "conflicting" && !resolving && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning-surface px-4 py-2.5 text-xs"
        >
          <span>
            This branch conflicts with {detail.baseBranch}.
            {snapshot.autoResolvePaused &&
              ` prkit already resolved this pull request's conflicts automatically ${AUTO_RESOLVE_LIMIT} times in the last 24 hours, so this one waits for you.`}
          </span>
          <ResolveConflictsButton detail={detail} />
        </div>
      )}
      <ol aria-label="Fixes" className="space-y-3">
        {snapshot.turns.map((turn) => (
          <li key={turn.id}>
            <FixTurnCard
              detail={detail}
              turn={turn}
              activity={turn.id === current?.id ? snapshot.activity : []}
              ahead={busy}
              listsScripts={listingScripts.has(turn.id)}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
