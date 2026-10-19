import type { InboxFilters, InboxResult } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { toastManager } from "~/components/ui/toast";
import { saveInboxFilters } from "~/rpc/client";
import { repositoriesQuery, workspaceQuery } from "~/rpc/queries";

import { repositoryGone, sameRepository, withLiveAccounts } from "./inboxPresentation";
import { useInboxStore } from "./inboxStore";

/** Typing in the search is saved once it pauses this long; other filters at once. */
const SEARCH_SAVE_DELAY = 400;

/**
 * Keeps the Inbox's filters with the server's workspace, so a reload or a relaunch shows
 * the same ones, less any account the inbox no longer has, and drops a saved repository filter
 * whose repository is gone. `inbox` is the inbox once it has loaded. Both come from prkit
 * without waiting for GitHub. Says whether the rows can show: the saved filters are back, or
 * couldn't be read, so a relaunch never draws unfiltered rows first.
 */
export function useSavedInboxFilters(inbox: InboxResult | undefined) {
  const client = useQueryClient();
  const saved = useQuery({ ...workspaceQuery, select: (workspace) => workspace.inboxFilters });
  const entries = inbox?.entries;
  const { restored, sortRestored, search, account, repository, sort } = useInboxStore(
    useShallow(({ restored, sortRestored, search, account, repository, sort }) => ({
      restored,
      sortRestored,
      search,
      account,
      repository,
      sort,
    })),
  );
  // What this window sent last, so each change is sent once and a remount sends nothing.
  const sent = useRef<InboxFilters | null>(null);
  const { mutate: save } = useMutation({
    mutationFn: saveInboxFilters,
    // One write at a time, in order, so the last change is the one kept.
    scope: { id: "inbox-filters" },
    onSuccess: (workspace) => client.setQueryData(workspaceQuery.queryKey, workspace),
    onError: (error) => {
      sent.current = null;
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
    const live = accounts.map((row) => row.accountId);
    useInboxStore.getState().restore(withLiveAccounts(saved.data, live));
  }, [saved.data, accounts]);
  useEffect(() => {
    if (!restored || !saved.data) return;
    const last = sent.current ?? saved.data;
    const searchOnly =
      account === last.account && sameRepository(repository, last.repository) && sort === last.sort;
    if (searchOnly && search === last.search) return;
    const timer = setTimeout(
      () => {
        sent.current = { search, account, repository, sort };
        save(sent.current);
      },
      searchOnly ? SEARCH_SAVE_DELAY : 0,
    );
    return () => clearTimeout(timer);
  }, [restored, search, account, repository, sort, saved.data, save]);
  useEffect(() => {
    const savedAt = saved.data?.savedAt ?? null;
    if (
      repository !== null &&
      savedAt !== null &&
      list.data &&
      entries &&
      repositoryGone(list.data, entries, repository, savedAt)
    )
      useInboxStore.getState().setRepository(null);
  }, [repository, saved.data, list.data, entries]);
  return (restored && sortRestored) || saved.isError;
}
