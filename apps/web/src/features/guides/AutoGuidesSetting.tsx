import { useQuery } from "@tanstack/react-query";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { FailedSave } from "~/features/settings/FailedSave";
import { accountsQuery } from "~/rpc/queries";

import { AutoGuideAccountRow } from "./AutoGuideAccountRow";
import { useGuideSettings } from "./useGuideSettings";

/** Write guides for review requests without a click, per account. */
export function AutoGuidesSetting() {
  const { settings, update } = useGuideSettings();
  const accounts = useQuery(accountsQuery);
  const loadError = settings.error ?? accounts.error;
  const data =
    settings.data !== undefined && accounts.data !== undefined
      ? { settings: settings.data, accounts: accounts.data }
      : undefined;
  return (
    <>
      {loadError !== null ? (
        <ListError
          title="Couldn't load guide settings"
          message={loadError.message}
          retry={() => {
            void settings.refetch();
            void accounts.refetch();
          }}
        />
      ) : data === undefined ? (
        <ListSkeleton label="Loading guide settings" rows={2} kind="accounts" />
      ) : (
        <div className="mt-5 border-t border-border/60 pt-5">
          <p className="text-sm">Write guides automatically for PRs that request my review</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Uses your subscription with the default agent. One at a time, never more than two
            agents, and never again for a PR that already has a guide.
          </p>
          {data.accounts.accounts.length === 0 ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              No GitHub accounts yet. Add one under Accounts.
            </p>
          ) : (
            <ul aria-label="Automatic guides by account" className="mt-2">
              {data.accounts.accounts.map((account) => (
                <AutoGuideAccountRow
                  key={account.id}
                  account={account}
                  checked={data.settings.autoAccounts.includes(account.id)}
                  disabled={update.isPending}
                  onChange={(checked) =>
                    update.mutate({
                      autoAccounts: checked
                        ? [...data.settings.autoAccounts, account.id]
                        : data.settings.autoAccounts.filter((id) => id !== account.id),
                    })
                  }
                />
              ))}
            </ul>
          )}
          <FailedSave save={update} />
        </div>
      )}
    </>
  );
}
