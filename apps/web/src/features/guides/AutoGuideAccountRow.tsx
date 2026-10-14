import type { Account } from "@prkit/contracts";

import { UserAvatar } from "~/components/UserAvatar";
import { Switch } from "~/components/ui/switch";

/** One account's switch for writing guides on its review requests without a click. */
export function AutoGuideAccountRow({
  account,
  checked,
  disabled,
  onChange,
}: {
  account: Account;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li className="flex min-h-12 items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-0">
      <span className="flex min-w-0 items-center gap-2.5">
        <UserAvatar login={account.login} url={account.avatarUrl} />
        <span className="truncate text-sm">{account.login}</span>
        <span className="text-xs text-muted-foreground">{account.host}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled || account.status._tag === "error"}
        aria-label={`Write guides automatically for ${account.login}`}
        onCheckedChange={onChange}
      />
    </li>
  );
}
