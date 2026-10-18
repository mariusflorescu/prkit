import type { AttemptSummary, LocalReview, RevisionSummary } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { agentLabel } from "~/components/review/agent/agentSelection";
import { guideProgress } from "~/components/review/progressModel";
import { ProgressBar } from "~/components/review/ProgressBar";
import { ReviewStatusLine } from "~/components/review/ReviewStatusLine";
import { type GuideChoice, RevisionSwitcher } from "~/components/review/RevisionSwitcher";
import { agentCatalogQuery } from "~/rpc/queries";

import { isRunning, LOCAL_WORDS } from "./localPresentation";

/** Above a local guide: what the review is doing, who writes it, and which revision is shown. */
export function LocalGuideStatusBar({
  review,
  attempt,
  revisions,
  selected,
  onSelect,
}: {
  review: LocalReview;
  attempt: AttemptSummary | null;
  revisions: ReadonlyArray<RevisionSummary>;
  selected: GuideChoice;
  onSelect: (choice: GuideChoice) => void;
}) {
  const catalog = useQuery(agentCatalogQuery);
  const running = isRunning(review.status);
  const progress = running && attempt !== null ? guideProgress(attempt) : null;
  const agent = agentLabel(catalog.data, {
    instance: review.instance,
    provider: review.provider,
    model: review.model,
    options: review.modelOptions,
  });
  return (
    <div className="shrink-0 border-b border-border">
      <div
        role="status"
        aria-label="Guide status"
        className="flex min-h-10 items-center justify-between gap-3 px-(--workspace-gutter-start) text-xs text-muted-foreground"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <ReviewStatusLine
            status={review.status}
            watchProblem={null}
            attempt={attempt}
            words={LOCAL_WORDS}
          />
        </span>
        <span className="flex min-w-0 shrink-0 items-center gap-2">
          <span data-agent-label="" className="hidden max-w-56 truncate lg:inline" title={agent}>
            {agent}
          </span>
          <RevisionSwitcher
            revisions={revisions}
            selected={selected}
            onSelect={onSelect}
            draft={running && attempt?.draft != null ? { revision: attempt.revision } : null}
            words={LOCAL_WORDS}
          />
        </span>
      </div>
      {progress !== null && <ProgressBar fraction={progress.fraction} label={progress.label} />}
    </div>
  );
}
