import { type AccountId, type GitHubProblem, primaryInboxReason } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { AppInfoFooter } from "~/components/AppInfoFooter";
import { CollapsingPinned } from "~/components/CollapsingPinned";
import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { InboxEmpty } from "~/features/inbox/InboxEmpty";
import { InboxGroup } from "~/features/inbox/InboxGroup";
import { InboxHeader } from "~/features/inbox/InboxHeader";
import { InboxNotices } from "~/features/inbox/InboxNotices";
import { InboxRepositoryEmpty } from "~/features/inbox/InboxRepositoryEmpty";
import { InboxToolbar } from "~/features/inbox/InboxToolbar";
import {
  INBOX_GROUPS,
  matchesInboxFilter,
  repositoryKey,
} from "~/features/inbox/inboxPresentation";
import { useInboxStore } from "~/features/inbox/inboxStore";
import { useSavedInboxFilters } from "~/features/inbox/useSavedInboxFilters";
import { useCollapsingHeader } from "~/hooks/useCollapsingHeader";
import { listInbox, refreshAccounts } from "~/rpc/client";
import { accountsQuery, inboxQuery } from "~/rpc/queries";
import "~/features/inbox/inbox.css";

export function InboxPage() {
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery);
  const inbox = useQuery(inboxQuery);
  const search = useInboxStore((state) => state.search);
  const chosenAccount = useInboxStore((state) => state.account);
  const repository = useInboxStore((state) => state.repository);
  const sort = useInboxStore((state) => state.sort);
  const clear = useInboxStore((state) => state.clear);
  useSavedInboxFilters(inbox.data?.entries);
  // With one account, its filter and each row's account say nothing, so neither shows.
  const manyAccounts = (accounts.data?.accounts.length ?? 0) > 1;
  const account = manyAccounts ? chosenAccount : null;
  const scroll = useRef<HTMLDivElement>(null);
  const { collapsed, sentinel } = useCollapsingHeader(scroll);
  const refresh = useMutation({
    mutationFn: () => listInbox({ _tag: "refresh" }),
    onSuccess: (result) => queryClient.setQueryData(inboxQuery.queryKey, result),
  });
  // Reads one account again; its login is checked again only after GitHub refused its token.
  const retryAccount = useMutation({
    mutationFn: async (input: { accountId: AccountId; problem: GitHubProblem }) => {
      if (input.problem._tag === "account")
        queryClient.setQueryData(accountsQuery.queryKey, await refreshAccounts());
      return listInbox({ _tag: "retry", accountId: input.accountId });
    },
    onSuccess: (result) => queryClient.setQueryData(inboxQuery.queryKey, result),
  });
  const recover = useMutation({
    mutationFn: refreshAccounts,
    onSuccess: (result) => {
      queryClient.setQueryData(accountsQuery.queryKey, result);
      refresh.mutate();
    },
  });
  const entries = inbox.data?.entries ?? [];
  const visible = entries.filter((entry) => matchesInboxFilter(entry, search, account, repository));
  const filtered = search.trim() !== "" || account !== null || repository !== null;
  const groups = INBOX_GROUPS.flatMap(({ reason, title }) => {
    const inGroup = visible.filter((entry) => primaryInboxReason(entry.reasons) === reason);
    return filtered && inGroup.length === 0 ? [] : [{ reason, title, entries: inGroup }];
  });
  const error =
    recover.error ?? refresh.error ?? retryAccount.error ?? inbox.error ?? accounts.error;
  const retry = () => {
    refresh.reset();
    retryAccount.reset();
    recover.mutate();
  };
  const inView =
    inbox.data?.accounts.filter((row) => account === null || row.accountId === account) ?? [];
  const oldest =
    inView
      .flatMap((row) => (row.fetchedAt === null ? [] : [row.fetchedAt]))
      .toSorted()
      .at(0) ?? null;
  const refreshing = inbox.isFetching || refresh.isPending;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroll} data-inbox-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <InboxHeader
          sentinel={sentinel}
          collapsed={collapsed}
          fetchedAt={oldest}
          refreshing={refreshing}
          onRefresh={() => refresh.mutate()}
        />
        <CollapsingPinned collapsed={collapsed}>
          <InboxToolbar
            accounts={manyAccounts ? (accounts.data?.accounts ?? []) : []}
            account={account}
            entries={entries}
            collapsed={collapsed}
            refreshing={refreshing}
            onRefresh={() => refresh.mutate()}
          />
        </CollapsingPinned>
        <div className="px-(--workspace-gutter-start) py-3">
          {error && (
            <ListError title="Couldn't refresh your inbox" message={error.message} retry={retry} />
          )}
          {inbox.isPending ? (
            <ListSkeleton label="Loading pull requests" />
          ) : (
            inbox.data && (
              <>
                <InboxNotices
                  result={inbox.data}
                  account={account}
                  retry={(accountId, problem) => retryAccount.mutate({ accountId, problem })}
                  retrying={
                    retryAccount.isPending ? (retryAccount.variables?.accountId ?? null) : null
                  }
                />
                {visible.length === 0 ? (
                  inView.some(
                    (row) => row.problem !== null && row.count === 0,
                  ) ? null : repository !== null && search.trim() === "" ? (
                    <InboxRepositoryEmpty
                      key={repositoryKey(repository)}
                      repository={repository}
                      clear={clear}
                    />
                  ) : (
                    <InboxEmpty
                      filtered={filtered}
                      noAccounts={(accounts.data?.accounts.length ?? 0) === 0}
                      clear={clear}
                    />
                  )
                ) : (
                  groups.map((group) => (
                    <InboxGroup
                      key={group.reason}
                      title={group.title}
                      entries={group.entries}
                      sort={sort}
                      showAccount={manyAccounts}
                    />
                  ))
                )}
              </>
            )
          )}
        </div>
      </div>
      <AppInfoFooter />
    </div>
  );
}
