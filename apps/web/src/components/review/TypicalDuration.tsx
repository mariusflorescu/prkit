import type { AgentProviderKind, PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { typicalDurationQuery } from "~/rpc/queries";

import { formatTypical } from "./reviewFormat";

/**
 * "Usually about 4 min for PRs this size", only when prkit has real past guides by the
 * same provider on a diff of similar size. Nothing otherwise.
 */
export function TypicalDuration({
  detail,
  provider,
}: {
  detail: PullRequestDetail;
  provider: AgentProviderKind | null;
}) {
  const typical = useQuery({
    ...typicalDurationQuery(provider ?? "claude", detail.additions + detail.deletions),
    enabled: provider !== null,
  });
  if (provider === null || typical.data == null) return null;
  return (
    <p data-typical-duration="" className="text-xs text-muted-foreground">
      Usually {formatTypical(typical.data.seconds)} for PRs this size
    </p>
  );
}
