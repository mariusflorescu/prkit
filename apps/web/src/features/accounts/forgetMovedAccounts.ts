import type { AccountId } from "@prkit/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { accountsQuery, inboxQuery, repositoriesQuery } from "~/rpc/queries";

/**
 * Each account is read through one gh config directory. When the accounts come back with an
 * account read through another directory, or gone, this window drops what it read through the
 * old one, so what it shows is read again through the new one, never kept from the old.
 */
export const forgetMovedAccounts = (client: QueryClient) => {
  let readThrough = new Map<AccountId, string>();
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== accountsQuery.queryKey[0]) return;
    const result = client.getQueryData(accountsQuery.queryKey);
    if (result === undefined) return;
    const next = new Map(result.accounts.map((account) => [account.id, account.configDir]));
    const moved = [...readThrough]
      .filter(([id, configDir]) => next.get(id) !== configDir)
      .map(([id]) => id);
    readThrough = next;
    if (moved.length === 0) return;
    void client.resetQueries({
      predicate: (query) => moved.some((id) => query.queryKey.includes(id)),
    });
    void client.invalidateQueries({ queryKey: inboxQuery.queryKey });
    void client.invalidateQueries({ queryKey: repositoriesQuery.queryKey });
  });
};
