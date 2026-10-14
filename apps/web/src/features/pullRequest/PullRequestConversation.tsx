import { pullRequestActionReason, type PullRequestDetail } from "@prkit/contracts";
import { TagIcon, UserPlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { usePullRequestActions } from "./actionContext";
import { ConversationStream } from "./ConversationStream";
import { LabelChip } from "./LabelChip";
import { PullRequestChecks } from "./PullRequestChecks";
import { PullRequestDescription } from "./PullRequestDescription";
import { PullRequestReviewers } from "./PullRequestReviewers";
import "./pullRequest.css";

/** GitHub's Conversation: reviewers and labels, the description, the activity, then checks. */
export function PullRequestConversation({ detail }: { detail: PullRequestDetail }) {
  const actions = usePullRequestActions();
  return (
    <div data-pr-conversation="" className="min-w-0">
      <div className="space-y-2 px-4 pt-2.5 pb-1">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <PullRequestReviewers reviewers={detail.reviewers} decision={detail.reviewDecision} />
          </div>
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Edit reviewers"
            disabled={actions.pending || pullRequestActionReason(detail, "reviewers") !== null}
            title={pullRequestActionReason(detail, "reviewers") ?? undefined}
            onClick={(event) => actions.show("reviewers", event.currentTarget)}
          >
            <UserPlusIcon />
          </Button>
        </div>
        <section
          aria-label="Labels"
          className="grid min-h-6 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs"
        >
          <h2 className="flex items-center gap-1.5 text-muted-foreground">
            <TagIcon aria-hidden className="size-3.5" />
            Labels
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              {detail.labels.length > 0 ? (
                <ul className="flex flex-wrap gap-1">
                  {detail.labels.map((label) => (
                    <li key={label.name} className="flex">
                      <LabelChip label={label} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p role="status" className="text-muted-foreground">
                  No labels
                </p>
              )}
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label="Edit labels"
              disabled={actions.pending || pullRequestActionReason(detail, "labels") !== null}
              title={pullRequestActionReason(detail, "labels") ?? undefined}
              onClick={(event) => actions.show("labels", event.currentTarget)}
            >
              <TagIcon />
            </Button>
          </div>
        </section>
      </div>
      <div className="px-4 pt-4 pb-2">
        <PullRequestDescription detail={detail} />
        <ConversationStream detail={detail} />
      </div>
      <PullRequestChecks checks={detail.checks} />
    </div>
  );
}
