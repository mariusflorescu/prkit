import type { PullRequestDetail } from "@prkit/contracts";
import type { ReactNode } from "react";

import { PullRequestActionsMenu } from "./PullRequestActionsMenu";
import { PullRequestPrimaryAction } from "./PullRequestPrimaryAction";

/** At most three things, each action once: Review, the primary action, and ⋯ for the rest. */
export function PullRequestHeaderActions({
  detail,
  reviewAction,
}: {
  detail: PullRequestDetail;
  reviewAction?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Pull request actions"
      className="flex shrink-0 items-center gap-1.5"
    >
      <div data-pr-review-action-slot="">{reviewAction}</div>
      <PullRequestPrimaryAction detail={detail} />
      <PullRequestActionsMenu detail={detail} />
    </div>
  );
}
