import type { Account } from "@prkit/contracts";

import { UserAvatar } from "~/components/UserAvatar";
import { Button } from "~/components/ui/button";

import { AccountBudget } from "./AccountBudget";

export function AccountRow({
  account,
  removable,
  removing,
  remove,
  retry,
  retrying,
}: {
  account: Account;
  removable: boolean;
  removing: boolean;
  remove: (path: string) => void;
  retry: () => void;
  retrying: boolean;
}) {
  return (
    <li className="flex min-h-20 items-start gap-3 border-b border-border/60 py-4 last:border-0">
      <UserAvatar login={account.login} url={account.avatarUrl} size="large" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{account.login}</span>
          <span className="text-xs text-muted-foreground">{account.host}</span>
          <span
            className={
              account.status._tag === "ready"
                ? "text-xs text-success-foreground"
                : "text-xs text-error-foreground"
            }
          >
            {account.status._tag === "ready" ? "Ready" : "Needs attention"}
          </span>
        </div>
        {account.name && <p className="text-xs text-muted-foreground">{account.name}</p>}
        <p className="break-all font-mono text-2xs text-muted-foreground">{account.configDir}</p>
        <AccountBudget accountId={account.id} />
        {account.status._tag === "error" && (
          <div role="alert" className="space-y-2 pt-1 text-xs text-error-foreground">
            <p>{account.status.message}</p>
            <Button size="sm" variant="outline" disabled={retrying} onClick={retry}>
              Retry
            </Button>
          </div>
        )}
      </div>
      {removable && (
        <Button
          size="sm"
          variant="ghost-destructive"
          disabled={removing}
          onClick={() => remove(account.configDir)}
        >
          Remove
        </Button>
      )}
    </li>
  );
}
