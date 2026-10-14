import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "~/components/ui/skeleton";
import { fixerQuery, pushAccessQuery } from "~/rpc/queries";

/** What happens to the agent's commit: reviewed first, pushed automatically, or patch only. */
export function PushNotice({ detail }: { detail: PullRequestDetail }) {
  const access = useQuery(pushAccessQuery(detail.key, detail.accountId));
  const fixer = useQuery(fixerQuery(detail.key));
  if (access.isPending)
    return <Skeleton aria-busy="true" aria-label="Loading push access" className="h-4 w-56" />;
  if (access.isError)
    return (
      <p role="alert" className="text-xs text-error-foreground">
        {access.error.message} You still review the changes before anything is pushed.
      </p>
    );
  if (access.data._tag === "denied")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {access.data.reason} You'll get a patch to copy instead.
      </p>
    );
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {fixer.data?.settings.pushAutomatically
        ? `prkit pushes the fix to ${access.data.branch} as soon as it's ready (on for this repository).`
        : `You review the changes before prkit pushes them to ${access.data.branch}.`}
    </p>
  );
}
