"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, SearchIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const Combobox = ComboboxPrimitive.Root;
const ComboboxCollection = ComboboxPrimitive.Collection;

/** A borderless search field on top of an inline list. */
function ComboboxSearchInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <div className="shrink-0 px-2.5 pt-2">
      <div className="relative border-b border-border/70 pb-1 transition-colors duration-150 focus-within:border-ring">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 left-0 size-3.5 text-muted-foreground/60"
        />
        <ComboboxPrimitive.Input
          className={cn(
            "h-6 w-full bg-transparent ps-5 text-xs leading-6 outline-none placeholder:text-muted-foreground/70",
            className,
          )}
          data-slot="combobox-input"
          {...props}
        />
      </div>
    </div>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("min-h-0 overflow-y-auto overscroll-contain p-1 empty:p-0", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      className={cn(
        "py-0.5 not-first:mt-0.5 not-first:border-t not-first:border-border/60",
        className,
      )}
      data-slot="combobox-group"
      {...props}
    />
  );
}

function ComboboxGroupLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      className={cn("px-2 pt-1.5 pb-0.5 text-2xs text-muted-foreground", className)}
      data-slot="combobox-group-label"
      {...props}
    />
  );
}

/** One 28px row: the caller's content, then a check that lines up on every row. */
function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:bg-foreground/[0.06] [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      {children}
      <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
        <ComboboxPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </ComboboxPrimitive.ItemIndicator>
      </span>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn("px-3 not-empty:py-2.5 text-center text-xs text-muted-foreground", className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

/** A quiet line under the list: how much is shown, or why some of it is missing. */
function ComboboxStatus({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("shrink-0 px-3 py-1.5 text-2xs text-muted-foreground", className)}
      data-slot="combobox-status"
      {...props}
    />
  );
}

/** The bar under a picker's list for its one action, such as checking again. */
function ComboboxFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-2 py-1 text-2xs text-muted-foreground",
        className,
      )}
      data-slot="combobox-footer"
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxCollection,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxStatus,
  ComboboxFooter,
};
