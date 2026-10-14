import {
  type GuidanceMode,
  type PullRequestGuideConfig,
  resolveGuideConfig,
  SCOPE_LABELS,
} from "@prkit/contracts";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { GuidanceModeControl } from "~/features/settings/guides/GuidanceModeControl";
import { InheritedGuidance } from "~/features/settings/guides/InheritedGuidance";

import { ComposerControl } from "../agent/ComposerControl";
import { aboveThePullRequest } from "./useGuideConfigPreview";

/**
 * "Guidance: Global + Repository + this PR": which blocks the agent gets. The PR's
 * own block is the setup's focus; here it can replace the blocks above instead.
 */
export function GuidanceChip({
  config,
  text,
  mode,
  onMode,
}: {
  config: PullRequestGuideConfig;
  /** What the setup's focus field holds now. */
  text: string;
  mode: GuidanceMode;
  onMode: (mode: GuidanceMode) => void;
}) {
  const above = resolveGuideConfig(aboveThePullRequest(config)).guidance;
  const own = text.trim() !== "";
  const used = [
    ...(mode === "replace"
      ? []
      : above
          .filter((block) => block.replacedBy === null)
          .map((block) => SCOPE_LABELS[block.scope])),
    ...(own ? ["this PR"] : []),
  ];
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl size="xs" />}>
        {used.length === 0 ? "No guidance" : `Guidance: ${used.join(" + ")}`}
      </PopoverTrigger>
      <PopoverPopup width="xl" align="start">
        <div aria-label="Guidance for this pull request" role="group" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            The focus is this pull request's guidance; it's saved when you generate. The agent gets
            every block labelled by scope, and when two conflict the more specific one wins.
          </p>
          {above.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              No Global or repository guidance. Add some in Settings &gt; Guides.
            </p>
          ) : (
            <InheritedGuidance blocks={above} replaced={mode === "replace"} />
          )}
          <GuidanceModeControl
            label="How this pull request's guidance combines with the guidance above"
            value={mode}
            onChange={onMode}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
