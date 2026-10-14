"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ComponentProps, type ReactElement, type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";

import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxSearchInput,
  ComboboxStatus,
} from "./combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { selectTriggerVariants } from "./select";

/** A titled run of items; `label: null` for a group that needs no heading. */
export interface SearchPickerGroup<T> {
  readonly value: string;
  readonly label: ReactNode;
  readonly items: ReadonlyArray<T>;
}

/** More rows than this make the list slow to open; search narrows it instead. */
const SHOWN_AT_MOST = 200;

const matching = <T,>(
  groups: ReadonlyArray<SearchPickerGroup<T>>,
  query: string,
  itemText: (item: T) => string,
) => {
  const needle = query.trim().toLowerCase();
  const found = groups.map((group) => ({
    value: group.value,
    label: group.label,
    items: group.items.filter((item) => itemText(item).toLowerCase().includes(needle)),
  }));
  const total = found.reduce((sum, group) => sum + group.items.length, 0);
  let room = SHOWN_AT_MOST;
  const shown = found
    .map((group) => {
      const items = group.items.slice(0, Math.max(0, room));
      room -= items.length;
      return { value: group.value, label: group.label, items };
    })
    .filter((group) => group.items.length > 0);
  return { shown, total, cut: total > SHOWN_AT_MOST };
};

/** The field look of a picker's trigger, the same as a select's. */
export function SearchPickerField({ className, children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(selectTriggerVariants({ size: "default" }), className)}
      data-slot="search-picker-field"
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronDownIcon aria-hidden="true" className="-me-1 size-3 opacity-50" />
    </button>
  );
}

/**
 * A searchable list in a popover: groups with small headings, 28px rows, a check on
 * the chosen row, and room above and below the list for loading lines and one action.
 */
export function SearchPicker<T>({
  trigger,
  children,
  groups,
  value,
  itemKey,
  itemText,
  renderItem,
  itemDisabled,
  itemTitle,
  onSelect,
  onOpenChange,
  searchLabel,
  empty,
  status,
  footer,
  width = "sm",
  align = "start",
  disabled = false,
}: {
  /** The element that opens it, such as `<SearchPickerField aria-label=… />`. */
  trigger: ReactElement;
  children: ReactNode;
  groups: ReadonlyArray<SearchPickerGroup<T>>;
  value: T | null;
  itemKey: (item: T) => string;
  /** What search matches and what typeahead reads. */
  itemText: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  itemDisabled?: (item: T) => boolean;
  itemTitle?: (item: T) => string | undefined;
  onSelect: (item: T) => void;
  onOpenChange?: (open: boolean) => void;
  searchLabel: string;
  empty: (query: string) => ReactNode;
  status?: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md";
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { shown, total, cut } = matching(groups, query, itemText);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !disabled);
        onOpenChange?.(next && !disabled);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger disabled={disabled} render={trigger}>
        {children}
      </PopoverTrigger>
      <PopoverPopup padding="none" width={width} align={align}>
        <Combobox
          inline
          open
          autoHighlight
          items={groups}
          filteredItems={shown}
          filter={null}
          value={value}
          inputValue={query}
          onInputValueChange={setQuery}
          itemToStringLabel={itemText}
          isItemEqualToValue={(item: T, other: T) => itemKey(item) === itemKey(other)}
          onValueChange={(item: T | null) => {
            if (item === null) return;
            onSelect(item);
            setOpen(false);
            setQuery("");
          }}
        >
          <ComboboxSearchInput aria-label={searchLabel} placeholder={searchLabel} />
          {status}
          <ComboboxList className="max-h-72">
            {shown.map((group) => (
              <ComboboxGroup key={group.value} items={group.items}>
                {group.label !== null && <ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>}
                <ComboboxCollection>
                  {(item: T) => (
                    <ComboboxItem
                      key={itemKey(item)}
                      value={item}
                      disabled={itemDisabled?.(item) ?? false}
                      title={itemTitle?.(item)}
                    >
                      {renderItem(item)}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            ))}
          </ComboboxList>
          <ComboboxEmpty>{empty(query.trim())}</ComboboxEmpty>
          {cut && (
            <ComboboxStatus role="status">
              Showing {SHOWN_AT_MOST} of {total.toLocaleString()}. Type to narrow it down.
            </ComboboxStatus>
          )}
        </Combobox>
        {footer}
      </PopoverPopup>
    </Popover>
  );
}
