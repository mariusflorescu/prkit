import {
  type PullRequestGuideConfig,
  type PullRequestKey,
  resolveGuideConfig,
} from "@prkit/contracts";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { PathRulesEditor } from "~/features/settings/guides/PathRulesEditor";

import { ComposerControl } from "../agent/ComposerControl";
import { IgnorePreviewList } from "./IgnorePreviewList";
import { aboveThePullRequest, type GuideConfigPreview } from "./useGuideConfigPreview";

const chipLabel = (preview: GuideConfigPreview) => {
  if (preview.skipped === null) return preview.files.isError ? "Ignore rules" : "Checking files…";
  const count = preview.skipped.length;
  return count === 0 ? "No files skipped" : `Skipping ${count} file${count === 1 ? "" : "s"}`;
};

/** "Skipping 7 files": the per-file preview and this PR's own ignore rules. */
export function IgnoreChip({
  pullRequest,
  preview,
  config,
}: {
  pullRequest: PullRequestKey;
  preview: GuideConfigPreview;
  config: PullRequestGuideConfig;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl size="xs" />}>{chipLabel(preview)}</PopoverTrigger>
      <PopoverPopup width="xl" align="start" padding="none">
        <div
          aria-label="Ignore rules for this pull request"
          role="group"
          className="max-h-[70vh] space-y-5 overflow-y-auto p-4"
        >
          <IgnorePreviewList preview={preview} />
          <PathRulesEditor
            kind="ignore"
            scope={{ _tag: "pull-request", key: pullRequest }}
            scopeLabel="This pull request"
            section={config.pullRequest.ignore}
            inherited={resolveGuideConfig(aboveThePullRequest(config)).ignore}
            onReload={() => void preview.config.refetch()}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
