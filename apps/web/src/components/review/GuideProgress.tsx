import type { AttemptSummary, PullRequestDetail, Review, ReviewSnapshot } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { agentCatalogQuery } from "~/rpc/queries";

import { agentLabel } from "./agent/agentSelection";
import { AttemptFileList } from "./AttemptFileList";
import { DraftView } from "./DraftView";
import { guideProgress } from "./progressModel";
import { NarrationLine } from "./NarrationLine";
import { ProgressBar } from "./ProgressBar";
import { ProgressHeader } from "./ProgressHeader";
import { useReviewActions } from "./useReviewActions";

/**
 * A first guide being written: what the agent is doing in one line, the files it
 * has read with its notes, then the draft itself as soon as it shares one.
 */
export function GuideProgress({
  detail,
  review,
  snapshot,
  attempt,
}: {
  detail: PullRequestDetail;
  review: Review;
  snapshot: ReviewSnapshot;
  attempt: AttemptSummary;
}) {
  const { stop } = useReviewActions(detail.key);
  const catalog = useQuery(agentCatalogQuery);
  const progress = guideProgress(attempt);
  const name =
    catalog.data?.providers.find((entry) => entry.kind === review.provider)?.label ??
    (review.provider === "claude" ? "Claude" : "Codex");
  const title =
    progress.stage === "reading"
      ? `${name} is reading this PR`
      : progress.stage === "writing"
        ? `${name} is writing the guide`
        : progress.stage === "checking"
          ? `${name} is checking the guide`
          : progress.label;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <section
        aria-labelledby="guide-progress-title"
        className="mx-auto w-full max-w-4xl shrink-0 space-y-3 px-6 pt-5 pb-3"
      >
        <ProgressHeader
          title={title}
          agent={agentLabel(catalog.data, {
            provider: review.provider,
            model: review.model,
            options: review.modelOptions,
          })}
          label={progress.label}
          startedAt={attempt.startedAt}
          stopping={stop.isPending}
          onStop={() => stop.mutate()}
        />
        <ProgressBar fraction={progress.fraction} label={progress.label} />
        {stop.error && (
          <p role="alert" className="text-xs text-error-foreground">
            {stop.error.message}{" "}
            <Button variant="link" size="xs" onClick={() => stop.mutate()}>
              Retry
            </Button>
          </p>
        )}
        <NarrationLine
          narration={attempt.narration}
          fallback={
            progress.stage === "queued" || progress.stage === "preparing"
              ? progress.label
              : `Waiting for ${name}'s first step`
          }
          activity={snapshot.activity}
        />
      </section>
      {attempt.draft === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 pb-8">
            <AttemptFileList
              reviewKey={detail.key}
              attemptId={attempt.id}
              files={attempt.files}
              expected={detail.changedFiles}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <DraftView
            detail={detail}
            attemptId={attempt.id}
            version={attempt.draft.version}
            growing={attempt.draft.growing}
          />
        </div>
      )}
    </div>
  );
}
