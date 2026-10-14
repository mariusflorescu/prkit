import {
  type PullRequestGuideConfig,
  type PullRequestKey,
  type ResolvedGuideConfig,
  resolveGuideConfig,
} from "@prkit/contracts";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { FocusAreasEditor } from "~/features/settings/guides/FocusAreasEditor";

import { ComposerControl } from "../agent/ComposerControl";
import { aboveThePullRequest, type GuideConfigPreview } from "./useGuideConfigPreview";

/** "2 focus areas": the questions this guide answers, inherited ones switchable here. */
export function FocusChip({
  pullRequest,
  preview,
  config,
  resolved,
}: {
  pullRequest: PullRequestKey;
  preview: GuideConfigPreview;
  config: PullRequestGuideConfig;
  resolved: ResolvedGuideConfig;
}) {
  const active = resolved.focusAreas.filter((area) => area.active).length;
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl size="xs" />}>
        {active === 0 ? "No focus areas" : `${active} focus area${active === 1 ? "" : "s"}`}
      </PopoverTrigger>
      <PopoverPopup width="xl" align="start" padding="none">
        <div
          aria-label="Focus areas for this pull request"
          role="group"
          className="max-h-[70vh] overflow-y-auto p-4"
        >
          <FocusAreasEditor
            scope={{ _tag: "pull-request", key: pullRequest }}
            scopeLabel="This pull request"
            section={config.pullRequest.focus}
            inherited={resolveGuideConfig(aboveThePullRequest(config)).focusAreas}
            onReload={() => void preview.config.refetch()}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
