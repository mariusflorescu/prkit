"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const Menu = MenuPrimitive.Root;

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "start",
  side = "bottom",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        className="z-[130]"
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "relative flex min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] duration-150 ease-out [-webkit-app-region:no-drag] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuGroupLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn("px-2 pt-1.5 pb-0.5 text-2xs text-muted-foreground", className)}
      data-slot="menu-group-label"
      {...props}
    />
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "grid min-h-7 cursor-pointer grid-cols-[minmax(0,1fr)_0.875rem] items-center gap-2 rounded-sm py-1 ps-2 pe-2 text-xs text-foreground outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="col-start-1 min-w-0">{children}</span>
      <MenuPrimitive.RadioItemIndicator className="col-start-2">
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs text-foreground outline-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 [&>svg]:pointer-events-none [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-slot="menu-item"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

export {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
};
