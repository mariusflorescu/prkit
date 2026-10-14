import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";

/** Items from less specific scopes, collapsed into "3 inherited, all on" until opened. */
export function InheritedItems({
  noun,
  total,
  off,
  children,
}: {
  noun: string;
  total: number;
  off: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (total === 0) return null;
  return (
    <div className="space-y-1">
      <Button variant="ghost-muted" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={open ? "rotate-90 transition-transform" : "transition-transform"}>
          <ChevronRightIcon />
        </span>
        {total} inherited, {off === 0 ? "all on" : `${off} off`}
      </Button>
      {open && (
        <ul aria-label={`Inherited ${noun}`} className="space-y-1">
          {children}
        </ul>
      )}
    </div>
  );
}
