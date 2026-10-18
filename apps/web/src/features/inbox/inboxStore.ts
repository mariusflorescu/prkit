import {
  type AccountId,
  type InboxFilters,
  type InboxSort,
  NO_INBOX_FILTERS,
  type RepositoryFilter,
} from "@prkit/contracts";
import { create } from "zustand";

/**
 * The Inbox's filters in this window. The server keeps the last ones for the next load:
 * `restore` applies them once, unless the user changed a filter before they arrived. The sort
 * needs no account, so `restoreSort` applies it as soon as it arrives, and the rows wait for it.
 */
export const useInboxStore = create<
  InboxFilters & {
    restored: boolean;
    sortRestored: boolean;
    setSearch: (search: string) => void;
    setAccount: (account: AccountId | null) => void;
    setRepository: (repository: RepositoryFilter | null) => void;
    setSort: (sort: InboxSort) => void;
    clear: () => void;
    restore: (saved: InboxFilters) => void;
    restoreSort: (sort: InboxSort) => void;
  }
>((set) => ({
  ...NO_INBOX_FILTERS,
  restored: false,
  sortRestored: false,
  setSearch: (search) => set({ search, restored: true }),
  setAccount: (account) => set({ account, restored: true }),
  setRepository: (repository) => set({ repository, restored: true }),
  setSort: (sort) => set({ sort, restored: true, sortRestored: true }),
  clear: () => set((state) => ({ ...NO_INBOX_FILTERS, sort: state.sort, restored: true })),
  restore: (saved) =>
    set((state) => (state.restored ? state : { ...saved, restored: true, sortRestored: true })),
  restoreSort: (sort) =>
    set((state) => (state.sortRestored ? state : { sort, sortRestored: true })),
}));
