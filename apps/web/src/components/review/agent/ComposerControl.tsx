import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

/** `sm` sits with 14px text (Settings, Fixes); `xs` is the guide setup's quiet 12px choice. */
export type ComposerControlSize = "sm" | "xs";

/**
 * The quiet control look of the model, settings and guide setup pickers. `xs` stays muted
 * until hovered or open. It is its own look, not a restyled Button, so it owns its classes.
 */
export function ComposerControl({
  size = "sm",
  render,
  ...props
}: useRender.ComponentProps<"button"> & { size?: ComposerControlSize }) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "relative inline-flex min-w-0 shrink cursor-pointer items-center whitespace-nowrap rounded-md border border-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0",
          size === "xs"
            ? "h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
            : "h-7 gap-1.5 px-2 text-sm font-medium text-foreground/80 hover:text-foreground",
        ),
        type: render ? undefined : "button",
      },
      props,
    ),
    render,
  });
}
