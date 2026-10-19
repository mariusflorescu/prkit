import type { AccountId, GitHubProblem, InboxResult } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { ReviewFeedNotice } from "~/components/review/ReviewFeedNotice";
import { FreshnessNotice } from "~/features/github/FreshnessNotice";
import { retryReviewFeed } from "~/rpc/client";
import { reviewFeedQuery } from "~/rpc/queries";

import { ConfigDirNotice } from "./ConfigDirNotice";
import { INBOX_GROUPS } from "./inboxPresentation";
import { useInboxStore } from "./inboxStore";

export function InboxNotices({
  result,
  account,
  retry,
  retrying,
  retryConfigDirs,
  retryingConfigDirs,
}: {
  result: InboxResult;
  account: AccountId | null;
  retry: (accountId: AccountId, problem: GitHubProblem) => void;
  retrying: AccountId | null;
  retryConfigDirs: () => void;
  retryingConfigDirs: boolean;
}) {
  const failed = useQuery({
    ...reviewFeedQuery,
    select: (feed) => (feed._tag === "failed" ? feed : null),
  }).data;
  const riskiest = useInboxStore((state) => state.sort === "risk");
  return (
    <div className="space-y-2 px-3">
      {failed && (
        <ReviewFeedNotice
          label="Couldn't read your guides"
          message={failed.message}
          retry={retryReviewFeed}
        >
          {failed.reviews === null
            ? `Guide marks and risk levels are hidden until it can${riskiest ? ", and Riskiest first orders by wait" : ""}.`
            : "Guide marks and risk levels may be out of date until it can."}
        </ReviewFeedNotice>
      )}
      {result.configDirProblems.map((problem) => (
        <ConfigDirNotice
          key={problem.configDir}
          problem={problem}
          retry={retryConfigDirs}
          retrying={retryingConfigDirs}
        />
      ))}
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
