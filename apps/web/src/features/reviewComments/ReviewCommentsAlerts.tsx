import type { AccountId, PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { pendingCommentsQuery, reviewThreadsQuery } from "~/rpc/queries";

/** Why drafts or GitHub's threads are missing from the diff, each with a way to retry. */
export function ReviewCommentsAlerts({
  pr,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
}) {
  const pending = useQuery(pendingCommentsQuery(pr.key, pr.accountId));
  const threads = useQuery(reviewThreadsQuery(pr.key, pr.accountId));
  const failures = [
    pending.isError && {
      id: "pending",
      text: `Couldn't load your pending comments. ${pending.error.message}`,
      retry: () => void pending.refetch(),
    },
    threads.isError && {
      id: "threads",
      text: `Couldn't load review threads from GitHub. ${threads.error.message}`,
      retry: () => void threads.refetch(),
    },
  ].filter((failure) => failure !== false);
  return failures.map((failure) => (
    <div
      key={failure.id}
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-error/30 bg-error-surface px-4 py-2 text-xs text-error-foreground"
    >
      <p>{failure.text}</p>
      <Button size="xs" variant="outline" onClick={failure.retry}>
        Retry
      </Button>
    </div>
  ));
}
