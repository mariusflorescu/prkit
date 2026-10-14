import {
  type AccountId,
  type InboxFilters,
  NO_INBOX_FILTERS,
  type RepositoryFilter,
} from "@prkit/contracts";
import { create } from "zustand";

/**
 * The Inbox's filters in this window. The server keeps the last ones for the next load:
 * `restore` applies them once, unless the user changed a filter before they arrived.
 */
export const useInboxStore = create<
  InboxFilters & {
    restored: boolean;
    setSearch: (search: string) => void;
    setAccount: (account: AccountId | null) => void;
    setRepository: (repository: RepositoryFilter | null) => void;
    clear: () => void;
    restore: (saved: InboxFilters) => void;
  }
>((set) => ({
  ...NO_INBOX_FILTERS,
  restored: false,
  setSearch: (search) => set({ search, restored: true }),
  setAccount: (account) => set({ account, restored: true }),
  setRepository: (repository) => set({ repository, restored: true }),
  clear: () => set({ ...NO_INBOX_FILTERS, restored: true }),
  restore: (saved) => set((state) => (state.restored ? state : { ...saved, restored: true })),
}));
