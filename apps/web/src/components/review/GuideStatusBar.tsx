import type {
  AttemptConfig,
  AttemptSummary,
  PullRequestDetail,
  Review,
  RevisionSummary,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { agentCatalogQuery, pullRequestGuideConfigQuery } from "~/rpc/queries";

import { agentLabel } from "./agent/agentSelection";
import { RevisionSettingsSummary } from "./config/RevisionSettingsSummary";
import { SettingsChangedNotice } from "./config/SettingsChangedNotice";
import { GenerateAgain } from "./GenerateAgain";
import { guideProgress } from "./progressModel";
import { ProgressBar } from "./ProgressBar";
import { PULL_REQUEST_WORDS } from "./reviewPresentation";
import { ReviewStatusLine } from "./ReviewStatusLine";
import { type GuideChoice, RevisionSwitcher } from "./RevisionSwitcher";
import { useReviewActions } from "./useReviewActions";

/** Above a guide: what the review is doing, who writes it, which revision is shown, and what you can do. */
export function GuideStatusBar({
  detail,
  review,
  attempt,
  revisions,
  selected,
  onSelect,
  shown,
}: {
  detail: PullRequestDetail;
  review: Review;
  attempt: AttemptSummary | null;
  revisions: ReadonlyArray<RevisionSummary>;
  selected: GuideChoice;
  onSelect: (choice: GuideChoice) => void;
  /** The settings of the revision on screen, once it loaded, and whether it is the newest. */
  shown: { readonly config: AttemptConfig; readonly latest: boolean } | null;
}) {
  const { stop, generate } = useReviewActions(detail.key);
  const catalog = useQuery(agentCatalogQuery);
  const settings = useQuery(pullRequestGuideConfigQuery(detail.key, detail.accountId));
  const status = review.status;
  const running = status._tag === "preparing" || status._tag === "writing";
  const canGenerate =
    status._tag === "watching" ||
    (status._tag === "done" && (status.reason === "stopped" || detail.state === "open"));
  const error = stop.error ?? generate.error;
  const progress = running && attempt !== null ? guideProgress(attempt) : null;
  const settingsChanged =
    canGenerate &&
    shown !== null &&
    shown.latest &&
    settings.data !== undefined &&
    settings.data.hash !== shown.config.hash;
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
            status={status}
            watchProblem={review.watchProblem}
            attempt={attempt}
            words={PULL_REQUEST_WORDS}
          />
          {shown !== null && <RevisionSettingsSummary config={shown.config} />}
        </span>
        <span className="flex min-w-0 shrink-0 items-center gap-2">
          {error && (
            <span role="alert" className="text-error-foreground">
              {error.message}
              <Button
                variant="outline"
                size="compact"
                disabled={stop.isPending || generate.isPending}
                onClick={() =>
                  error === stop.error
                    ? stop.mutate()
                    : generate.mutate({ accountId: detail.accountId })
                }
              >
                Retry
              </Button>
            </span>
          )}
          <span data-agent-label="" className="hidden max-w-56 truncate lg:inline" title={agent}>
            {agent}
          </span>
          <RevisionSwitcher
            revisions={revisions}
            selected={selected}
            onSelect={onSelect}
            draft={running && attempt?.draft != null ? { revision: attempt.revision } : null}
            words={PULL_REQUEST_WORDS}
          />
          {settingsChanged && (
            <SettingsChangedNotice
              pending={generate.isPending}
              onRegenerate={() => generate.mutate({ accountId: detail.accountId })}
            />
          )}
          {canGenerate && (
            <GenerateAgain
              detail={detail}
              review={review}
              pending={generate.isPending}
              onGenerate={() => generate.mutate({ accountId: detail.accountId })}
            />
          )}
          {status._tag !== "done" && (
            <Button
              variant="ghost-muted"
              size="compact"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              {running ? "Stop" : "Stop watching"}
            </Button>
          )}
        </span>
      </div>
      {progress !== null && <ProgressBar fraction={progress.fraction} label={progress.label} />}
    </div>
  );
}
