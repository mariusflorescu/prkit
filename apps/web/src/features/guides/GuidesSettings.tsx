import { GlobalGuideConfig } from "~/features/settings/guides/GlobalGuideConfig";
import { RepositoryGuideConfig } from "~/features/settings/guides/RepositoryGuideConfig";
import { SettingsSection } from "~/features/settings/SettingsSection";

import { AutoGuidesSetting } from "./AutoGuidesSetting";

/** Settings > Guides. One component per subsection, stacked here. */
export function GuidesSettings() {
  return (
    <SettingsSection
      title="Guides"
      description="Guides run on your own Claude or Codex subscription, on this machine."
    >
      <AutoGuidesSetting />
      <GlobalGuideConfig />
      <RepositoryGuideConfig />
    </SettingsSection>
  );
}
