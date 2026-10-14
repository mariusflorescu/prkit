import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type * as React from "react";

import { cn } from "~/lib/utils";

const sidebarMenuButtonClassName =
  "flex h-8 w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-left font-medium text-sidebar-muted-foreground/80 text-sm outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active active:text-sidebar-foreground data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";

/** A navigation row. Pass `render={<Link … />}` to make it a link. */
function SidebarMenuButton({
  isActive = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & { isActive?: boolean }) {
  const defaultProps = {
    className: cn(sidebarMenuButtonClassName, className),
    "data-active": isActive,
    "data-slot": "sidebar-menu-button",
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

function SidebarSectionLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-7 items-center px-[var(--sidebar-row-content-inset)] font-medium text-sidebar-muted-foreground text-xs",
        className,
      )}
      data-slot="sidebar-section-label"
      {...props}
    />
  );
}

export { SidebarMenuButton, SidebarSectionLabel };
