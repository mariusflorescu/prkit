import type { Account, AccountId, InboxEntry } from "@prkit/contracts";
import { RefreshCwIcon, SearchIcon } from "lucide-react";

import { ToolbarIconButton } from "~/components/ToolbarIconButton";
import { cn } from "~/lib/utils";

import { InboxAccountFilter } from "./InboxAccountFilter";
import { InboxRepositoryFilter } from "./InboxRepositoryFilter";
import { useInboxStore } from "./inboxStore";

/**
 * The Inbox's filters. It stays pinned when the list scrolls, and then also takes the
 * refresh button from the header that scrolled away.
 */
export function InboxToolbar({
  accounts,
  account,
  entries,
  collapsed,
  refreshing,
  onRefresh,
}: {
  /** The accounts to filter by; none when there is only one. */
  accounts: ReadonlyArray<Account>;
  /** The account filter in effect, null for all. */
  account: AccountId | null;
  entries: ReadonlyArray<InboxEntry>;
  collapsed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const search = useInboxStore((state) => state.search);
  const setSearch = useInboxStore((state) => state.setSearch);
  return (
    <div className="flex h-12 items-center gap-2 border-b border-border bg-background pr-(--workspace-gutter-end) pl-(--workspace-gutter-start)">
      <div className="relative min-w-40 flex-1">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
        />
        <input
          aria-label="Search pull requests"
          type="search"
          placeholder="Search title, repository, author or #number"
          autoComplete="off"
          spellCheck={false}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
        />
      </div>
      {accounts.length > 1 && <InboxAccountFilter accounts={accounts} />}
      <InboxRepositoryFilter entries={entries} account={account} />
      <span data-collapse-compact="" inert={!collapsed} aria-hidden={!collapsed}>
        <ToolbarIconButton label="Refresh" disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
        </ToolbarIconButton>
      </span>
    </div>
  );
}
