import type { AccountBinding, AccountId } from "@prkit/contracts";
import { notifyManager, type QueryClient } from "@tanstack/react-query";

import {
  accountsQuery,
  inboxQuery,
  pullRequestStatusQuery,
  readInboxAgain,
  repositoriesQuery,
} from "~/rpc/queries";

/**
 * Each account is read through one gh config directory. The server says which whenever this
 * window starts listening or a discovery changes one, and in the accounts list; the first it hears
 * is what this window read through. When an account is read through another directory, or is
 * gone, this window drops what it read through the old one, so what it shows is read again
 * through the new one, never kept from the old.
 */
export const forgetMovedAccounts = (client: QueryClient) => {
  let readThrough: ReadonlyMap<AccountId, string> | null = null;
  // The events come in order; a list answer can overtake them, so it counts only until they speak.
  let heard = false;
  const forget = (moved: ReadonlyArray<AccountId>) => {
    // A key can hold the account inside an object (a diff's source), so look in the whole hash.
    void client.resetQueries({
      predicate: (query) => moved.some((id) => query.queryHash.includes(JSON.stringify(id))),
    });
    client.setQueryData(pullRequestStatusQuery.queryKey, (statuses) =>
      statuses === undefined
        ? statuses
        : new Map([...statuses].filter(([, status]) => !moved.includes(status.accountId))),
    );
    // A tab falls back to its inbox row, so the moved accounts' rows go now, as unread.
    client.setQueryData(inboxQuery.queryKey, (inbox) =>
      inbox === undefined
        ? inbox
        : {
            ...inbox,
            entries: inbox.entries.filter((entry) => !moved.includes(entry.accountId)),
            leftOut: inbox.leftOut.filter((item) => !moved.includes(item.accountId)),
            truncated: inbox.truncated.filter((item) => !moved.includes(item.accountId)),
            accounts: inbox.accounts.map((row) =>
              moved.includes(row.accountId)
                ? { ...row, count: 0, fetchedAt: null, problem: null }
                : row,
            ),
          },
    );
    readInboxAgain(client);
    void client.invalidateQueries({ queryKey: repositoriesQuery.queryKey });
  };
  const rebind = (bindings: ReadonlyArray<AccountBinding>) => {
    const next = new Map(bindings.map((binding) => [binding.accountId, binding.configDir]));
    const moved = [...(readThrough ?? [])]
      .filter(([id, configDir]) => next.get(id) !== configDir)
      .map(([id]) => id);
    readThrough = next;
    if (moved.length > 0) notifyManager.batch(() => forget(moved));
    return moved;
  };
  const fromList = () => {
    const result = client.getQueryData(accountsQuery.queryKey);
    if (result === undefined || heard) return;
    rebind(
      result.accounts.map((account) => ({ accountId: account.id, configDir: account.configDir })),
    );
  };
  fromList();
  // Only a new answer: a read starting or going stale still holds the last one.
  const stop = client.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      event.query.queryKey[0] === accountsQuery.queryKey[0]
    )
      fromList();
  });
  return {
    rebind: (bindings: ReadonlyArray<AccountBinding>) => {
      heard = true;
      return rebind(bindings);
    },
    stop,
  };
};
