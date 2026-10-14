import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";

import { SETTINGS_SECTIONS } from "~/features/settings/settingsSections";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { cn } from "~/lib/utils";
import { ShortcutTooltip } from "./ShortcutTooltip";
import { TabCloseButton } from "./TabCloseButton";
import { tabSurface } from "./tabSurface";

/** Settings as a tab at the end of the strip: a PR tab's look, never reordered among them. */
export function SettingsWorkspaceTab({ active }: { active: boolean }) {
  const workspace = useWorkspace();
  const section = useWorkspaceSession((state) => state.settingsTab.section);
  const to = SETTINGS_SECTIONS.find((candidate) => candidate.id === section)?.to ?? "/settings";
  return (
    <div
      data-active-tab={active}
      data-settings-tab=""
      className={cn(
        "group/tab flex h-6 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs [-webkit-app-region:no-drag]",
        tabSurface(active),
      )}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          workspace.closeSettings();
        }
      }}
    >
      <TabCloseButton label="Close Settings" onClose={workspace.closeSettings}>
        <SettingsIcon aria-hidden="true" className="size-3" />
      </TabCloseButton>
      <ShortcutTooltip label="Settings" shortcut="settings">
        <Link
          to={to}
          aria-current={active ? "page" : undefined}
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Settings
        </Link>
      </ShortcutTooltip>
    </div>
  );
}
