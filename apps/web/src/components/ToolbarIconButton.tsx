import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** An icon-only toolbar button: its label is its accessible name and its tooltip. */
export function ToolbarIconButton({
  label,
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  /** For a toggle: whether it is on. */
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={pressed === true ? "secondary" : "ghost-muted"}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
