import type { AccountId, GitHubLimit } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { clockTime } from "~/features/github/freshness";
import { githubBudgetQuery } from "~/rpc/queries";

const NAMES = { graphql: "GraphQL", core: "REST" } as const;
const UNITS = { graphql: "points", core: "requests" } as const;
const count = new Intl.NumberFormat();

const limitText = (limit: GitHubLimit) =>
  limit.pausedUntil !== null
    ? `used up until ${clockTime(limit.pausedUntil)}`
    : `${count.format(limit.remaining)} of ${count.format(limit.limit)} left, resets at ${clockTime(limit.resetAt)}`;

/** What GitHub's last answers said about this account's limits, and what prkit spent of them. */
export function AccountBudget({ accountId }: { accountId: AccountId }) {
  const budget = useQuery(githubBudgetQuery);
  if (budget.isPending)
    return (
      <span aria-busy="true" aria-label="Loading GitHub limits" className="block pt-1">
        <Skeleton className="h-3 w-64" />
      </span>
    );
  if (budget.isError)
    return (
      <div role="alert" className="flex items-center gap-2 pt-1 text-xs text-error-foreground">
        <p>{budget.error.message}</p>
        <Button size="sm" variant="outline" onClick={() => void budget.refetch()}>
          Retry
        </Button>
      </div>
    );
  const limits = budget.data.accounts.find((row) => row.accountId === accountId)?.limits ?? [];
  if (limits.length === 0)
    return (
      <p role="status" className="pt-1 text-xs text-muted-foreground">
        No GitHub reads through this account since prkit started.
      </p>
    );
  return (
    <ul aria-label={`GitHub limits for ${accountId}`} className="space-y-0.5 pt-1 text-xs">
      {limits.map((limit) => (
        <li
          key={limit.resource}
          data-github-limit={limit.resource}
          className="text-muted-foreground"
        >
          <span className="text-foreground">{NAMES[limit.resource]}</span> {limitText(limit)}. prkit
          used {count.format(limit.spentLastHour)} {UNITS[limit.resource]} in the last hour.
        </li>
      ))}
    </ul>
  );
}
