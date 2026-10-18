import type { GuidanceMode, PullRequestKey } from "@prkit/contracts";

import { Skeleton } from "~/components/ui/skeleton";

import { GuideSetupProblem } from "../GuideSetupProblem";
import { FocusChip } from "./FocusChip";
import { GuidanceChip } from "./GuidanceChip";
import { IgnoreChip } from "./IgnoreChip";
import { SensitiveChip } from "./SensitiveChip";
import type { GuideConfigPreview } from "./useGuideConfigPreview";

/**
 * One muted line of what the guide will skip, answer and be told:
 * "No files skipped · Look closely: none · 2 focus areas · Guidance: Global". Each item opens
 * this PR's settings.
 */
export function GuideSettingsLine({
  pullRequest,
  preview,
  guidance,
  mode,
  onMode,
}: {
  pullRequest: PullRequestKey;
  preview: GuideConfigPreview;
  guidance: string;
  mode: GuidanceMode;
  onMode: (mode: GuidanceMode) => void;
}) {
  const { config, resolved } = preview;
  if (config.isError)
    return (
      <GuideSetupProblem
        title="Couldn't load this pull request's guide settings"
        message={config.error.message}
        onRetry={() => void config.refetch()}
      />
    );
  if (config.data === undefined || resolved === null)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading guide settings"
        className="flex h-6 items-center gap-3 px-1.5"
      >
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-24" />
      </div>
    );
  const dot = (
    <span aria-hidden="true" className="text-xs text-muted-foreground/60">
      ·
    </span>
  );
  return (
    <div role="group" aria-label="Guide settings" className="flex min-w-0 flex-wrap items-center">
      <IgnoreChip pullRequest={pullRequest} preview={preview} config={config.data} />
      {dot}
      <SensitiveChip pullRequest={pullRequest} preview={preview} config={config.data} />
      {dot}
      <FocusChip
        pullRequest={pullRequest}
        preview={preview}
        config={config.data}
        resolved={resolved}
      />
      {dot}
      <GuidanceChip config={config.data} text={guidance} mode={mode} onMode={onMode} />
    </div>
  );
}
