"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";

const Popover = PopoverPrimitive.Root;

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

const popoverWidthClassName = {
  auto: "",
  sm: "w-64",
  md: "w-80",
  lg: "w-96",
  xl: "w-[30rem]",
} as const;

/** `none` is for content that draws its own frame edge to edge, like a model list. */
const popoverPaddingClassName = {
  default: "p-4",
  compact: "px-3 py-2",
  none: "p-0",
} as const;

function PopoverPopup({
  children,
  className,
  padding = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props & {
  padding?: keyof typeof popoverPaddingClassName;
  width?: keyof typeof popoverWidthClassName;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        className="z-[130] max-w-(--available-width)"
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex max-h-(--available-height) origin-(--transform-origin) flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            width !== "auto" && ["max-w-[calc(100vw-2rem)]", popoverWidthClassName[width]],
            popoverPaddingClassName[padding],
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverPopup };
