import type { InboxResult } from "@prkit/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { toastManager } from "~/components/ui/toast";
import { saveInboxFilters } from "~/rpc/client";
import { repositoriesQuery, workspaceQuery } from "~/rpc/queries";

import { repositoryGone, sameFilters, sameRepository, withLiveAccounts } from "./inboxPresentation";
import { useInboxStore } from "./inboxStore";

/** Typing in the search is saved once it pauses this long; other filters at once. */
const SEARCH_SAVE_DELAY = 400;
const SAVE_KEY = ["inbox-filters"];

/**
 * Keeps the Inbox's filters with the server's workspace, so a reload or a relaunch shows
 * the same ones, less any account the inbox no longer has, and drops a saved repository filter
 * whose repository is gone. While the user has no change waiting to be saved, the window shows
 * the newest saved filters, from another window, an outside agent or the CLI included. A change
 * not sent yet wins and is saved after; for one already on its way, the save the server stored
 * last decides. `inbox` is the inbox once it has loaded. Both come from prkit without waiting
 * for GitHub. Says whether the rows can show: the saved filters are back, or couldn't be read,
 * so a relaunch never draws unfiltered rows first.
 */
export function useSavedInboxFilters(inbox: InboxResult | undefined) {
  const client = useQueryClient();
  const saved = useQuery({ ...workspaceQuery, select: (workspace) => workspace.inboxFilters });
  const entries = inbox?.entries;
  const { restored, sortRestored, unsaved, saveFailed, typing, search, account, repository, sort } =
    useInboxStore(
      useShallow((state) => ({
        restored: state.restored,
        sortRestored: state.sortRestored,
        unsaved: state.unsaved,
        saveFailed: state.saveFailed,
        typing: state.typing,
        search: state.search,
        account: state.account,
        repository: state.repository,
        sort: state.sort,
      })),
    );
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
  const { mutate: save } = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: saveInboxFilters,
    // One write at a time, in order, so the last change is the one kept.
    scope: { id: "inbox-filters" },
    onSuccess: (workspace, filters) => {
      client.setQueryData(workspaceQuery.queryKey, workspace);
      useInboxStore.getState().confirm(filters);
    },
    onError: (error, filters) => {
      useInboxStore.getState().fail(filters);
      toastManager.add({
        type: "error",
        title: "Couldn't save your Inbox filters",
        description: error.message,
      });
    },
  });
  const list = useQuery({ ...repositoriesQuery, enabled: repository !== null });

  useEffect(() => {
    if (saved.data) useInboxStore.getState().restoreSort(saved.data.sort);
  }, [saved.data]);
  const accounts = inbox?.accounts;
  useEffect(() => {
    if (!saved.data || !accounts) return;
    const filters = withLiveAccounts(
      saved.data,
      accounts.map((row) => row.accountId),
    );
    useInboxStore.getState().restore(filters, !sameFilters(filters, saved.data));
  }, [saved.data, accounts]);
  useEffect(() => {
    if (!restored || !saved.data) return;
    const here = { search, account, repository, sort };
    if (!unsaved) {
      if (!accounts || sameFilters(here, saved.data)) return;
      const filters = withLiveAccounts(
        saved.data,
        accounts.map((row) => row.accountId),
      );
      useInboxStore.getState().adopt(filters, !sameFilters(filters, saved.data));
      return;
    }
    if (saving || saveFailed) return;
    if (sameFilters(here, saved.data)) {
      useInboxStore.getState().confirm(here);
      return;
    }
    const timer = setTimeout(() => save(here), typing ? SEARCH_SAVE_DELAY : 0);
    return () => clearTimeout(timer);
  }, [
    restored,
    unsaved,
    saving,
    saveFailed,
    typing,
    search,
    account,
    repository,
    sort,
    saved.data,
    accounts,
    save,
  ]);
  useEffect(() => {
    const savedAt = saved.data?.savedAt ?? null;
    const store = useInboxStore.getState();
    // Only the repository still chosen, never one a save made elsewhere has just replaced.
    if (
      repository !== null &&
      sameRepository(store.repository, repository) &&
      savedAt !== null &&
      list.data &&
      entries &&
      repositoryGone(list.data, entries, repository, savedAt)
    )
      store.setRepository(null);
  }, [repository, saved.data, list.data, entries]);
  return (restored && sortRestored) || saved.isError;
}
