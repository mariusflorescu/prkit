import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "~/components/ui/skeleton";
import { scriptAccessQuery } from "~/rpc/queries";

/** One quiet line: whether the fix agent runs this repository's check scripts on this PR, and why. */
export function ScriptAccessNotice({ detail }: { detail: PullRequestDetail }) {
  const access = useQuery(scriptAccessQuery(detail.key, detail.accountId));
  if (access.isPending)
    return (
      <Skeleton
        aria-busy="true"
        aria-label="Loading whether the agent runs scripts"
        className="h-4 w-80"
      />
    );
  if (access.isError)
    return (
      <p role="alert" className="text-xs text-error-foreground">
        Couldn't check whether the agent may run this pull request's scripts. {access.error.message}{" "}
        <button type="button" className="underline" onClick={() => void access.refetch()}>
          Retry
        </button>
      </p>
    );
  return (
    <p role="status" aria-label="Check scripts" className="text-xs text-muted-foreground">
      {access.data._tag === "allowed"
        ? `The agent may run this repository's test, lint and type check scripts: ${access.data.reason}.`
        : `The agent runs none of this pull request's scripts: ${access.data.reason}. It reads and edits files only.`}
    </p>
  );
}
