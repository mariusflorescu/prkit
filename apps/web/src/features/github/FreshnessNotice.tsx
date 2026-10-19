import type { AccountId, GitHubProblem } from "@prkit/contracts";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { clockTime, freshnessText, retryAt } from "./freshness";
import { useNow } from "./useNow";
import { useReached } from "./useReached";

/**
 * Says why prkit shows a cached answer and how old it is. Retry stays off until a
 * used-up limit resets, so a click can't spend a request GitHub would refuse.
 */
export function FreshnessNotice({
  problem,
  accountId,
  fetchedAt,
  retry,
  retrying,
}: {
  problem: GitHubProblem;
  accountId: AccountId;
  fetchedAt: string | null;
  retry: () => void;
  retrying: boolean;
}) {
  const now = useNow();
  const resetAt = retryAt(problem);
  const ready = useReached(resetAt);
  return (
    <div
      role="alert"
      data-github-problem={problem._tag}
      data-account={accountId}
      className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
    >
      <p className="min-w-0 flex-1 text-warning-foreground">
        {freshnessText(problem, accountId, fetchedAt, now)}
      </p>
      {problem._tag === "account" && (
        <Link to="/settings" className="text-warning-foreground underline underline-offset-2">
          Accounts
        </Link>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!ready || retrying}
        title={
          !ready && problem._tag === "rate-limited"
            ? `Available at ${clockTime(problem.resetAt)}`
            : undefined
        }
        onClick={retry}
      >
        <ButtonLabel
          shown={retrying ? "retrying" : "retry"}
          labels={{ retry: "Retry", retrying: "Retrying..." }}
        />
      </Button>
    </div>
  );
}
