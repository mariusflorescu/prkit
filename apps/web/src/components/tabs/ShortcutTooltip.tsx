import type { ReactElement } from "react";

import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type ShortcutId, shortcutHints } from "~/features/workspace/shortcuts";

/** A title bar control's name and its keyboard shortcut, on hover or focus. */
export function ShortcutTooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut: ShortcutId;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={400} render={children} />
      <TooltipPopup side="bottom" sideOffset={6}>
        <span className="flex items-center gap-2">
          {label}
          {shortcutHints(shortcut).map((hint) => (
            <Kbd key={hint}>{hint}</Kbd>
          ))}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
