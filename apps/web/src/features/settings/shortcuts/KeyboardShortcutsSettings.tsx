import { SHORTCUTS } from "~/features/workspace/shortcuts";

import { SettingsSection } from "../SettingsSection";
import { ShortcutRow } from "./ShortcutRow";

const GROUPS = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];

/** Settings > Keyboard shortcuts: read-only, straight from the table the shortcut handler uses. */
export function KeyboardShortcutsSettings() {
  return (
    <SettingsSection
      title="Keyboard shortcuts"
      description="Cmd on macOS is Ctrl on Windows and Linux."
    >
      {GROUPS.map((group) => (
        <div key={group} className="mt-6">
          <h3 className="text-xs font-medium text-muted-foreground">{group}</h3>
          <ul aria-label={group} className="mt-2 border-y border-border/60">
            {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
              <ShortcutRow key={shortcut.id} shortcut={shortcut} />
            ))}
          </ul>
        </div>
      ))}
    </SettingsSection>
  );
}
