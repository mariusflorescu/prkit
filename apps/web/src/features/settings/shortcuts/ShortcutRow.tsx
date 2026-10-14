import { Fragment } from "react";

import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { keycaps, type Shortcut } from "~/features/workspace/shortcuts";

/** One shortcut: what it does, and every key combination that runs it. */
export function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="text-sm">{shortcut.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {shortcut.bindings.map((binding, index) => {
          const caps = keycaps(binding);
          return (
            <Fragment key={caps.join("+")}>
              {index > 0 && <span className="text-xs text-muted-foreground">or</span>}
              <KbdGroup>
                {caps.map((cap) => (
                  <Kbd key={cap}>{cap}</Kbd>
                ))}
              </KbdGroup>
            </Fragment>
          );
        })}
      </span>
    </li>
  );
}
