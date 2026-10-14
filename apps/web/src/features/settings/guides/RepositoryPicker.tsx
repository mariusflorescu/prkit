import type { AccountId, GuideRepository } from "@prkit/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";

import { findGuideRepository } from "~/rpc/client";
import { guideRepositoriesQuery, inboxQuery } from "~/rpc/queries";

import {
  SearchPicker,
  SearchPickerField,
  type SearchPickerGroup,
} from "~/components/ui/search-picker";

import { LoadProblem } from "./LoadProblem";

interface InboxRepository {
  readonly accountId: AccountId;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

const nameKey = (repository: { host: string; owner: string; name: string }) =>
  `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();

/** A repository with settings of its own, or one the inbox found that has none yet. */
type RepositoryChoice =
  | { readonly _tag: "configured"; readonly repository: GuideRepository }
  | { readonly _tag: "inbox"; readonly repository: InboxRepository };

const choiceKey = (choice: RepositoryChoice) =>
  choice._tag === "configured"
    ? `id:${choice.repository.id}`
    : `name:${nameKey(choice.repository)}`;

/**
 * Repositories with settings of their own, then the ones in the inbox. Picking an
 * inbox repository looks up its GitHub id through the account that found it.
 */
export function RepositoryPicker({
  selected,
  onSelect,
}: {
  selected: GuideRepository | null;
  onSelect: (repository: GuideRepository) => void;
}) {
  const configured = useQuery(guideRepositoriesQuery);
  // Only what the inbox already loaded: Settings never reads GitHub just to fill this list.
  const inbox = useQuery({ ...inboxQuery, enabled: false });
  const find = useMutation({ mutationFn: findGuideRepository, onSuccess: onSelect });
  const listed = [
    ...(configured.data ?? []),
    ...(selected === null || configured.data?.some((entry) => entry.id === selected.id) === true
      ? []
      : [selected]),
  ];
  const known = new Set(listed.map(nameKey));
  const fromInbox = new Map<string, InboxRepository>();
  for (const entry of inbox.data?.entries ?? []) {
    const repository = {
      accountId: entry.accountId,
      host: entry.ref.host,
      owner: entry.ref.owner,
      name: entry.ref.repo,
    };
    const key = nameKey(repository);
    if (!known.has(key) && !fromInbox.has(key)) fromInbox.set(key, repository);
  }
  const inboxRepositories = [...fromInbox.values()].toSorted((left, right) =>
    nameKey(left).localeCompare(nameKey(right)),
  );
  const choices: ReadonlyArray<SearchPickerGroup<RepositoryChoice>> = [
    {
      value: "configured",
      label: "Your repositories",
      items: listed.map((repository) => ({ _tag: "configured", repository })),
    },
    {
      value: "inbox",
      label: "From your inbox",
      items: inboxRepositories.map((repository) => ({ _tag: "inbox", repository })),
    },
  ];
  const choose = (choice: RepositoryChoice) => {
    find.reset();
    if (choice._tag === "configured") onSelect(choice.repository);
    else find.mutate(choice.repository);
  };
  if (configured.isError)
    return (
      <LoadProblem
        title="Couldn't load your repositories"
        message={configured.error.message}
        retry={() => void configured.refetch()}
      />
    );
  const empty = configured.isSuccess && listed.length === 0 && inboxRepositories.length === 0;
  const current = selected === null ? null : { _tag: "configured" as const, repository: selected };
  const label = configured.isPending
    ? "Loading repositories…"
    : find.isPending
      ? "Looking up the repository…"
      : selected === null
        ? "Pick a repository"
        : `${selected.owner}/${selected.name}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span id="guide-config-repository-label" className="text-xs text-muted-foreground">
          Repository
        </span>
        <SearchPicker
          trigger={
            <SearchPickerField
              aria-labelledby="guide-config-repository-label guide-config-repository-value"
              className="w-72"
            />
          }
          groups={choices}
          value={current}
          itemKey={choiceKey}
          itemText={(choice) => `${choice.repository.owner}/${choice.repository.name}`}
          renderItem={(choice) => (
            <span className="min-w-0 flex-1 truncate">
              {choice.repository.owner}/{choice.repository.name}
            </span>
          )}
          onSelect={choose}
          searchLabel="Search repositories"
          empty={(query) => `No repositories match “${query}”`}
          disabled={configured.isPending || find.isPending || empty}
        >
          <span id="guide-config-repository-value">{label}</span>
        </SearchPicker>
      </div>
      {empty && (
        <p role="status" className="text-xs text-muted-foreground">
          No repositories yet. Repositories in your inbox show up here.
        </p>
      )}
      {find.error !== null && (
        <LoadProblem
          title="Couldn't look up that repository"
          message={find.error.message}
          retry={() => {
            if (find.variables !== undefined) find.mutate(find.variables);
          }}
        />
      )}
    </div>
  );
}
