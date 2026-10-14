import type { AccountId, GitHubProblem, InboxResult } from "@prkit/contracts";

import { FreshnessNotice } from "~/features/github/FreshnessNotice";

import { INBOX_GROUPS } from "./inboxPresentation";

export function InboxNotices({
  result,
  account,
  retry,
  retrying,
}: {
  result: InboxResult;
  account: AccountId | null;
  retry: (accountId: AccountId, problem: GitHubProblem) => void;
  retrying: AccountId | null;
}) {
  return (
    <div className="space-y-2 px-3">
      {result.accounts
        .filter((row) => account === null || account === row.accountId)
        .flatMap((row) =>
          row.problem === null
            ? []
            : [
                <FreshnessNotice
                  key={row.accountId}
                  problem={row.problem}
                  accountId={row.accountId}
                  fetchedAt={row.fetchedAt}
                  retry={() => row.problem !== null && retry(row.accountId, row.problem)}
                  retrying={retrying === row.accountId}
                />,
              ],
        )}
      {result.truncated
        .filter((item) => account === null || account === item.accountId)
        .map((item) => (
          <p
            key={`${item.accountId}/${item.reason}`}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          >
            Showing {item.shown} of {item.total} in{" "}
            {INBOX_GROUPS.find((group) => group.reason === item.reason)?.title} for {item.accountId}
            .
          </p>
        ))}
    </div>
  );
}
