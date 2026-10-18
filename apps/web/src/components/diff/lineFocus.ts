import type { DiffLineRef } from "@prkit/contracts";
import { create } from "zustand";

/** A new-side diff line another part of the page asked the guide to show, taken once. */
export type LineFocus = DiffLineRef & { readonly revision: number; readonly nonce: number };

let nonce = 0;

export const useLineFocus = create<{
  request: LineFocus | null;
  reveal: (at: Omit<LineFocus, "nonce">) => void;
  /** The guide showed the request with this nonce; a newer request stays. */
  take: (nonce: number) => void;
  /** Drops any request, once the guide it was for goes away. */
  clear: () => void;
}>((set) => ({
  request: null,
  reveal: (at) => set({ request: { ...at, nonce: ++nonce } }),
  take: (taken) => set((state) => (state.request?.nonce === taken ? { request: null } : state)),
  clear: () => set({ request: null }),
}));
