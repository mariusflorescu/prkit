import type * as React from "react";

import { Separator } from "./separator";

/** Buttons joined into one control, such as a split button: the inner corners and borders go. */
function Group({ children, ...props }: Omit<React.ComponentProps<"div">, "className">) {
  return (
    <div
      className="flex w-fit *:focus-visible:z-1 *:has-focus-visible:z-1 *:pointer-coarse:after:min-w-auto *:data-slot:has-[~[data-slot]]:rounded-e-none *:data-slot:has-[~[data-slot]]:border-e-0 *:data-slot:has-[~[data-slot]]:before:rounded-e-none *:[[data-slot]~[data-slot]]:rounded-s-none *:[[data-slot]~[data-slot]]:border-s-0 *:[[data-slot]~[data-slot]]:before:rounded-s-none"
      data-slot="group"
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}

/** The hairline between two joined buttons. */
function GroupSeparator() {
  return (
    <Separator
      className="pointer-events-none relative z-2 bg-primary-foreground/24"
      orientation="vertical"
    />
  );
}

export { Group, GroupSeparator };
