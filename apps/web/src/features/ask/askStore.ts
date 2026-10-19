import type { AskScope, ReviewKey } from "@prkit/contracts";
import { create } from "zustand";

/** A scope the reader picked, on the revision it belongs to. */
export type AskChoice = { readonly scope: AskScope; readonly revision: number };

/**
 * One review's Ask dock: whether its history is open, what it asks about (null for the
 * whole subject), the words typed so far, and whether the field should take focus.
 */
export type Dock = {
  readonly open: boolean;
  readonly choice: AskChoice | null;
  readonly draft: string;
  readonly focus: boolean;
};

const closed: Dock = { open: false, choice: null, draft: "", focus: false };

/**
 * In memory, per review, so leaving the Guide tab or switching revisions keeps the dock as it
 * was. The questions themselves are the server's.
 */
export const useAskStore = create<{
  docks: ReadonlyMap<ReviewKey, Dock>;
  update: (key: ReviewKey, change: Partial<Dock>) => void;
  /** Drops a removed review's dock, so one made again for the same branch starts closed. */
  forget: (key: ReviewKey) => void;
}>((set) => ({
  docks: new Map(),
  update: (key, change) =>
    set((state) => ({
      docks: new Map(state.docks).set(key, { ...(state.docks.get(key) ?? closed), ...change }),
    })),
  forget: (key) =>
    set((state) => {
      if (!state.docks.has(key)) return state;
      const docks = new Map(state.docks);
      docks.delete(key);
      return { docks };
    }),
}));

/** One field of a review's dock, so typing in it re-renders nothing else. */
export const useDock = <Field extends keyof Dock>(key: ReviewKey, field: Field) =>
  useAskStore((state) => (state.docks.get(key) ?? closed)[field]);

/** The lines the review's dock asks about on `revision`, or null when it asks about something else. */
export const useAskedLines = (key: ReviewKey, revision: number) => {
  const choice = useDock(key, "choice");
  return choice?.revision === revision && choice.scope._tag === "lines"
    ? choice.scope.anchor
    : null;
};

/** Opens the dock on `choice` and puts the cursor in its field. */
export const askAbout = (key: ReviewKey, choice: AskChoice | null) =>
  useAskStore.getState().update(key, { open: true, choice, focus: true });
