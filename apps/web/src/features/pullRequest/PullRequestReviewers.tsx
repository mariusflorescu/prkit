import type { PullRequestDetail } from "@prkit/contracts";
import { CheckIcon, UsersIcon } from "lucide-react";

import { UserAvatar } from "~/components/UserAvatar";
import { reviewStates } from "./pullRequestPresentation";

export function PullRequestReviewers({
  reviewers,
  decision,
}: {
  reviewers: PullRequestDetail["reviewers"];
  decision: PullRequestDetail["reviewDecision"];
}) {
  return (
    <section
      aria-label="Reviewers"
      className="grid min-h-6 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs"
    >
      <h2 className="flex items-center gap-1.5 text-muted-foreground">
        <UsersIcon aria-hidden className="size-3.5" />
        Reviewers
      </h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {reviewers.length === 0 ? (
          <p role="status" className="text-muted-foreground">
            No reviewers
          </p>
        ) : (
          reviewers.map((reviewer) => (
            <span
              key={reviewer.login}
              className="inline-flex items-center gap-1.5"
              title={`${reviewer.login} · ${reviewer.requested ? "Review requested" : (reviewStates[reviewer.state ?? ""] ?? "No review")}`}
            >
              <UserAvatar login={reviewer.login} url={reviewer.avatarUrl} />
              <span>{reviewer.login}</span>
              {reviewer.state === "APPROVED" ? (
                <CheckIcon aria-label="Approved" className="size-3 text-success-foreground" />
              ) : (
                reviewer.state && (
                  <span className="text-3xs text-muted-foreground">
                    {reviewStates[reviewer.state] ?? reviewer.state}
                  </span>
                )
              )}
              {reviewer.requested && (
                <span className="text-3xs text-muted-foreground">Requested</span>
              )}
            </span>
          ))
        )}
        {decision && (
          <span className="text-3xs text-muted-foreground">{reviewStates[decision]}</span>
        )}
      </div>
    </section>
  );
}
