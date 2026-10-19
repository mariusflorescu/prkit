import { type AccountId, loginOf } from "@prkit/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { useInboxStore } from "./inboxStore";

const ALL = "all";

const label = (id: AccountId) => {
  const host = id.slice(0, id.indexOf("/"));
  return host === "github.com" ? loginOf(id) : `${loginOf(id)} · ${host}`;
};

/** Which account's pull requests the Inbox shows; the login, with the host when it isn't github.com. */
export function InboxAccountFilter({
  accounts,
  account,
}: {
  accounts: ReadonlyArray<AccountId>;
  /** The account filter in effect, null for all. */
  account: AccountId | null;
}) {
  const setAccount = useInboxStore((state) => state.setAccount);
  const items = [
    { value: ALL, label: "All accounts" },
    ...accounts.map((id) => ({ value: id, label: label(id) })),
  ];
  return (
    <Select<string>
      value={account ?? ALL}
      items={items}
      onValueChange={(next) => setAccount(accounts.find((id) => id === next) ?? null)}
    >
      <SelectTrigger aria-label="Filter by GitHub account" className="w-44 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
