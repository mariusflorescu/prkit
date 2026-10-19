import {
  type AccountId,
  type InboxFilters,
  type InboxSort,
  NO_INBOX_FILTERS,
  type RepositoryFilter,
} from "@prkit/contracts";
import { create } from "zustand";

import { sameFilters } from "./inboxPresentation";

/** What a change the user makes here does besides itself. */
const changed = { restored: true, unsaved: true, saveFailed: false, typing: false } as const;

/**
 * The Inbox's filters in this window. The server keeps the last ones for the next load:
 * `restore` applies them once, unless the user changed a filter before they arrived, and the
 * rows wait for it. `restoreSort` applies the saved sort even then, unless the user chose one.
 * `unsaved` is set by the user's own changes until the server confirms it saved the filters
 * that show; while it isn't set, `adopt` shows the newest saved filters, whoever saved them.
 * `saveFailed` holds a failed save back until the user's next change. `typing` says the last
 * change was to the search, which is saved once typing pauses; any other is saved at once.
 */
export const useInboxStore = create<
  InboxFilters & {
    restored: boolean;
    sortRestored: boolean;
    unsaved: boolean;
    saveFailed: boolean;
    typing: boolean;
    setSearch: (search: string) => void;
    setAccount: (account: AccountId | null) => void;
    setRepository: (repository: RepositoryFilter | null) => void;
    setSort: (sort: InboxSort) => void;
    clear: () => void;
    restore: (saved: InboxFilters, unsaved: boolean) => void;
    restoreSort: (sort: InboxSort) => void;
    adopt: (saved: InboxFilters, unsaved: boolean) => void;
    confirm: (saved: InboxFilters) => void;
    fail: (filters: InboxFilters) => void;
  }
>((set) => ({
  ...NO_INBOX_FILTERS,
  restored: false,
  sortRestored: false,
  unsaved: false,
  saveFailed: false,
  typing: false,
  setSearch: (search) => set({ search, ...changed, typing: true }),
  setAccount: (account) => set({ account, ...changed }),
  setRepository: (repository) => set({ repository, ...changed }),
  setSort: (sort) => set({ sort, sortRestored: true, ...changed }),
  clear: () => set((state) => ({ ...NO_INBOX_FILTERS, sort: state.sort, ...changed })),
  restore: (saved, unsaved) =>
    set((state) =>
      state.restored ? state : { ...saved, restored: true, sortRestored: true, unsaved },
    ),
  restoreSort: (sort) =>
    set((state) => (state.sortRestored ? state : { sort, sortRestored: true })),
  adopt: (saved, unsaved) =>
    set({ ...saved, restored: true, sortRestored: true, unsaved, saveFailed: false }),
  confirm: (saved) =>
    set((state) => (sameFilters(state, saved) ? { unsaved: false, saveFailed: false } : state)),
  fail: (filters) => set((state) => (sameFilters(state, filters) ? { saveFailed: true } : state)),
}));
