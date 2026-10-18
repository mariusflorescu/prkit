import {
  type PullRequestGuideConfig,
  type PullRequestKey,
  resolveGuideConfig,
} from "@prkit/contracts";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { PathRulesEditor } from "~/features/settings/guides/PathRulesEditor";

import { ComposerControl } from "../agent/ComposerControl";
import { SensitivePreviewList } from "./SensitivePreviewList";
import { aboveThePullRequest, type GuideConfigPreview } from "./useGuideConfigPreview";

const chipLabel = (preview: GuideConfigPreview) => {
  if (preview.sensitive === null) return preview.files.isError ? "Look closely" : "Checking files…";
  const count = preview.sensitive.length;
  return count === 0
    ? "Look closely: none"
    : `Look closely: ${count} file${count === 1 ? "" : "s"}`;
};

/** "Look closely: 2 files": which changed files the look-closely paths match, and this PR's own paths. */
export function SensitiveChip({
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
          aria-label="Look-closely paths for this pull request"
          role="group"
          className="max-h-[70vh] space-y-5 overflow-y-auto p-4"
        >
          <SensitivePreviewList preview={preview} />
          <PathRulesEditor
            kind="sensitive"
            scope={{ _tag: "pull-request", key: pullRequest }}
            scopeLabel="This pull request"
            section={config.pullRequest.sensitive}
            inherited={resolveGuideConfig(aboveThePullRequest(config)).sensitive}
            onReload={() => void preview.config.refetch()}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
