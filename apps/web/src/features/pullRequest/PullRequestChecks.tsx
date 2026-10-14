import type { PullRequestDetail } from "@prkit/contracts";

import { PullRequestSection } from "./PullRequestSection";
import { PullRequestCheckList } from "./PullRequestCheckList";
import { checkSummary } from "./pullRequestPresentation";

export function PullRequestChecks({ checks }: { checks: PullRequestDetail["checks"] }) {
  return (
    <PullRequestSection
      title="Checks"
      open={checks.some((check) => check.status === "failing")}
      meta={checkSummary(checks)}
    >
      <PullRequestCheckList checks={checks} />
    </PullRequestSection>
  );
}
