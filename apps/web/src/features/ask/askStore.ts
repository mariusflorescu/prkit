import type { AskScope, PullRequestKey } from "@prkit/contracts";
import { create } from "zustand";

/** A scope the reader picked, on the revision it belongs to. */
export type AskChoice = { readonly scope: AskScope; readonly revision: number };

/**
 * One PR's Ask dock: whether its history is open, what it asks about (null for the whole
 * PR), the words typed so far, and whether the field should take focus.
 */
export type Dock = {
  readonly open: boolean;
  readonly choice: AskChoice | null;
  readonly draft: string;
  readonly focus: boolean;
};

const closed: Dock = { open: false, choice: null, draft: "", focus: false };

/**
 * In memory, per PR, so leaving the Guide tab or switching revisions keeps the dock as it
 * was. The questions themselves are the server's.
 */
export const useAskStore = create<{
  docks: ReadonlyMap<PullRequestKey, Dock>;
  update: (key: PullRequestKey, change: Partial<Dock>) => void;
}>((set) => ({
  docks: new Map(),
  update: (key, change) =>
    set((state) => ({
      docks: new Map(state.docks).set(key, { ...(state.docks.get(key) ?? closed), ...change }),
    })),
}));

/** One field of a PR's dock, so typing in it re-renders nothing else. */
export const useDock = <Field extends keyof Dock>(key: PullRequestKey, field: Field) =>
  useAskStore((state) => (state.docks.get(key) ?? closed)[field]);

/** Opens the dock on `choice` and puts the cursor in its field. */
export const askAbout = (key: PullRequestKey, choice: AskChoice | null) =>
  useAskStore.getState().update(key, { open: true, choice, focus: true });
