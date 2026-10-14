import type { AccountId, InboxEntry } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ComboboxFooter } from "~/components/ui/combobox";
import { SearchPicker, SearchPickerField } from "~/components/ui/search-picker";
import { ago } from "~/features/github/freshness";
import { useNow } from "~/features/github/useNow";
import { cn } from "~/lib/utils";
import { listRepositories } from "~/rpc/client";
import { repositoriesQuery } from "~/rpc/queries";

import {
  ALL_REPOSITORIES,
  type RepositoryChoice,
  repositoryChoices,
  repositoryKey,
} from "./inboxPresentation";
import { useInboxStore } from "./inboxStore";
import { RepositoryListStatus } from "./RepositoryListStatus";

/**
 * Filters the Inbox to one repository. The list holds every repository the accounts
 * can see, grouped by owner, read the first time it opens and kept a day by the server.
 */
export function InboxRepositoryFilter({
  entries,
  account,
}: {
  entries: ReadonlyArray<InboxEntry>;
  /** The account filter in effect, null for all. */
  account: AccountId | null;
}) {
  const client = useQueryClient();
  const now = useNow();
  const repository = useInboxStore((state) => state.repository);
  const setRepository = useInboxStore((state) => state.setRepository);
  const [opened, setOpened] = useState(false);
  const list = useQuery({ ...repositoriesQuery, enabled: opened });
  const refresh = useMutation({
    mutationFn: () => listRepositories({ _tag: "refresh" }),
    onSuccess: (result) => client.setQueryData(repositoriesQuery.queryKey, result),
  });
  const groups = repositoryChoices(list.data?.repositories ?? [], entries, account);
  const selected =
    repository === null
      ? ALL_REPOSITORIES
      : (groups
          .flatMap((group) => group.items)
          .find((choice) => choice.key === repositoryKey(repository)) ?? null);
  const label = repository === null ? "All repositories" : `${repository.owner}/${repository.name}`;
  const rows = (list.data?.accounts ?? []).filter(
    (row) => account === null || row.accountId === account,
  );
  const oldest =
    rows
      .flatMap((row) => (row.fetchedAt === null ? [] : [row.fetchedAt]))
      .toSorted()
      .at(0) ?? null;
  const error = refresh.error ?? list.error;
  return (
    <SearchPicker<RepositoryChoice>
      trigger={
        <SearchPickerField
          aria-label={`Filter by repository: ${label}`}
          className="w-56 shrink-0"
        />
      }
      groups={groups}
      value={selected}
      itemKey={(choice) => choice.key}
      itemText={(choice) =>
        choice._tag === "all" ? "All repositories" : `${choice.owner}/${choice.name}`
      }
      renderItem={(choice) =>
        choice._tag === "all" ? (
          <span className="min-w-0 flex-1 truncate">All repositories</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{choice.name}</span>
            {choice.count > 0 && (
              <span
                className="shrink-0 text-2xs tabular-nums text-muted-foreground"
                aria-label={`${choice.count} in your inbox`}
              >
                {choice.count}
              </span>
            )}
          </>
        )
      }
      onSelect={(choice) =>
        setRepository(
          choice._tag === "all"
            ? null
            : {
                host: choice.host,
                owner: choice.owner,
                name: choice.name,
                accountIds: choice.accountIds,
              },
        )
      }
      onOpenChange={(next) => {
        if (next) setOpened(true);
      }}
      searchLabel="Search repositories"
      empty={(query) => `No repositories match “${query}”`}
      status={
        <RepositoryListStatus
          loading={list.isPending}
          error={error?.message ?? null}
          rows={rows}
          retry={() => refresh.mutate()}
        />
      }
      footer={
        <ComboboxFooter>
          {oldest !== null && <span className="me-auto">Updated {ago(oldest, now)}</span>}
          <Button
            variant="ghost-muted"
            size="micro"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCwIcon
              className={cn(refresh.isPending && "animate-spin motion-reduce:animate-none")}
            />
            Refresh list
          </Button>
        </ComboboxFooter>
      }
      width="md"
      align="end"
    >
      {label}
    </SearchPicker>
  );
}
