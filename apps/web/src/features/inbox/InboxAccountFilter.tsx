import type { Account } from "@prkit/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { useInboxStore } from "./inboxStore";

const ALL = "all";

/** Which account's pull requests the Inbox shows; the login, with the host when it isn't github.com. */
export function InboxAccountFilter({ accounts }: { accounts: ReadonlyArray<Account> }) {
  const account = useInboxStore((state) => state.account);
  const setAccount = useInboxStore((state) => state.setAccount);
  const items = [
    { value: ALL, label: "All accounts" },
    ...accounts.map((item) => ({
      value: item.id,
      label: item.host === "github.com" ? item.login : `${item.login} · ${item.host}`,
    })),
  ];
  return (
    <Select<string>
      value={account ?? ALL}
      items={items}
      onValueChange={(next) => setAccount(accounts.find((item) => item.id === next)?.id ?? null)}
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
