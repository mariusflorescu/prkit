import type { InboxEntry, InboxFilters } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { toastManager } from "~/components/ui/toast";
import { saveInboxFilters } from "~/rpc/client";
import { accountsQuery, repositoriesQuery, workspaceQuery } from "~/rpc/queries";

import { repositoryGone, sameRepository, withLiveAccounts } from "./inboxPresentation";
import { useInboxStore } from "./inboxStore";

/** Typing in the search is saved once it pauses this long; other filters at once. */
const SEARCH_SAVE_DELAY = 400;

/**
 * Keeps the Inbox's filters with the server's workspace, so a reload or a relaunch shows
 * the same ones, less any account removed since, and drops a saved repository filter whose
 * repository is gone. `entries` is the inbox once it has loaded.
 */
export function useSavedInboxFilters(entries: ReadonlyArray<InboxEntry> | undefined) {
  const client = useQueryClient();
  const saved = useQuery({ ...workspaceQuery, select: (workspace) => workspace.inboxFilters });
  const accounts = useQuery(accountsQuery);
  const { restored, search, account, repository } = useInboxStore(
    useShallow(({ restored, search, account, repository }) => ({
      restored,
      search,
      account,
      repository,
    })),
  );
  // What this window sent last, so each change is sent once and a remount sends nothing.
  const sent = useRef<InboxFilters | null>(null);
  const { mutate: save } = useMutation({
    mutationFn: saveInboxFilters,
    // One write at a time, in order, so the last change is the one kept.
    scope: { id: "inbox-filters" },
    onSuccess: (inboxFilters) =>
      client.setQueryData(
        workspaceQuery.queryKey,
        (workspace) => workspace && { ...workspace, inboxFilters },
      ),
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
    if (saved.data && accounts.data)
      useInboxStore.getState().restore(withLiveAccounts(saved.data, accounts.data.accounts));
  }, [saved.data, accounts.data]);
  useEffect(() => {
    if (!restored || !saved.data) return;
    const last = sent.current ?? saved.data;
    const searchOnly = account === last.account && sameRepository(repository, last.repository);
    if (searchOnly && search === last.search) return;
    const timer = setTimeout(
      () => {
        sent.current = { search, account, repository };
        save(sent.current);
      },
      searchOnly ? SEARCH_SAVE_DELAY : 0,
    );
    return () => clearTimeout(timer);
  }, [restored, search, account, repository, saved.data, save]);
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
}
