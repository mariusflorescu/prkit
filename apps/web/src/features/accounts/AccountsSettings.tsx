import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { FailedSave } from "~/features/settings/FailedSave";
import { SettingsAlert } from "~/features/settings/SettingsAlert";
import { SettingsSection } from "~/features/settings/SettingsSection";
import { refreshAccounts, removeConfigDir } from "~/rpc/client";
import { accountsQuery, inboxQuery } from "~/rpc/queries";

import { AccountRow } from "./AccountRow";
import { AddConfigDirForm } from "./AddConfigDirForm";
import { ConfigDirProblemRow } from "./ConfigDirProblemRow";

export function AccountsSettings() {
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery);
  const refresh = useMutation({
    mutationFn: refreshAccounts,
    onSuccess: (result) => {
      queryClient.setQueryData(accountsQuery.queryKey, result);
      void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: removeConfigDir,
    onSuccess: (result) => {
      queryClient.setQueryData(accountsQuery.queryKey, result);
      void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
      toastManager.add({
        title: "GitHub directory removed",
        description: "The directory and its gh logins are unchanged.",
        type: "success",
      });
    },
  });
  return (
    <SettingsSection
      title="GitHub accounts"
      description="Your inbox uses each account's own GitHub login."
      action={
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCwIcon className="size-3.5" />
          {refresh.isPending ? "Refreshing..." : "Refresh"}
        </Button>
      }
    >
      {refresh.error !== null && (
        <SettingsAlert message={refresh.error.message} retry={() => refresh.mutate()} />
      )}
      {accounts.isPending ? (
        <ListSkeleton label="Loading GitHub accounts" rows={2} kind="accounts" />
      ) : accounts.isError ? (
        <ListError
          title="Couldn't load accounts"
          message={accounts.error.message}
          retry={() => void accounts.refetch()}
        />
      ) : (
        <>
          {accounts.data.accounts.length === 0 && accounts.data.configDirProblems.length === 0 ? (
            <div role="status" className="my-6 py-8 text-center">
              <h3 className="font-medium text-sm">No GitHub accounts found</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Run <code className="font-mono">gh auth login</code>, then refresh. You can also add
                a gh config directory below.
              </p>
            </div>
          ) : (
            <ul className="mt-5 border-y border-border/60">
              {accounts.data.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  removable={accounts.data.addedConfigDirs.includes(account.configDir)}
                  removing={remove.isPending}
                  remove={(path) => remove.mutate(path)}
                  retry={() => refresh.mutate()}
                  retrying={refresh.isPending}
                />
              ))}
              {accounts.data.configDirProblems.map((problem) => (
                <ConfigDirProblemRow
                  key={problem.configDir}
                  problem={problem}
                  removable={accounts.data.addedConfigDirs.includes(problem.configDir)}
                  removing={remove.isPending}
                  remove={(path) => remove.mutate(path)}
                  retry={() => refresh.mutate()}
                  retrying={refresh.isPending}
                />
              ))}
            </ul>
          )}
          {accounts.data.addedConfigDirs
            .filter(
              (path) =>
                !accounts.data.accounts.some((account) => account.configDir === path) &&
                !accounts.data.configDirProblems.some((problem) => problem.configDir === path),
            )
            .map((path) => (
              <div
                key={path}
                className="mt-3 flex items-center gap-3 border-b border-border/60 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-all font-mono text-xs">{path}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    No accounts found in this added directory.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(path)}
                >
                  Remove
                </Button>
              </div>
            ))}
          <FailedSave save={remove} />
        </>
      )}
      <div className="mt-8 border-t border-border/60 pt-6">
        <AddConfigDirForm />
      </div>
    </SettingsSection>
  );
}
