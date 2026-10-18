import { INBOX_SORT_IDS, INBOX_SORTS, type InboxSort } from "@prkit/contracts";
import { ArrowDownUpIcon } from "lucide-react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { useInboxStore } from "./inboxStore";

const items = INBOX_SORT_IDS.map((id) => ({ value: id, label: INBOX_SORTS[id].label }));

export function InboxSortSelect() {
  const sort = useInboxStore((state) => state.sort);
  const setSort = useInboxStore((state) => state.setSort);
  return (
    <Select<InboxSort>
      value={sort}
      items={items}
      onValueChange={(next) => {
        if (next !== null) setSort(next);
      }}
    >
      <SelectTrigger variant="ghost" size="compact" aria-label="Sort pull requests">
        <ArrowDownUpIcon aria-hidden="true" />
        <span className="hidden md:inline">
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} align="end">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
