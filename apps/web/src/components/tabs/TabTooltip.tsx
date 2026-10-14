import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Tooltip } from "~/components/ui/tooltip";

export function TabTooltip({
  children,
  number,
  details,
}: {
  children: ReactElement;
  number: number;
  details: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setExpanded(true), 650);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <Tooltip
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setExpanded(false);
      }}
    >
      <TooltipPrimitive.Trigger delay={100} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="bottom" sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup
            role="tooltip"
            className="max-w-80 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            <span>#{number}</span>
            {expanded && <div className="mt-1 space-y-1">{details}</div>}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </Tooltip>
  );
}
