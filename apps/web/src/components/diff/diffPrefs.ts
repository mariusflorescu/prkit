import { create } from "zustand";

export const useDiffPrefs = create<{
  diffStyle: "unified" | "split";
  wrap: boolean;
  setDiffStyle: (diffStyle: "unified" | "split") => void;
  toggleWrap: () => void;
}>((set) => ({
  diffStyle: "unified",
  wrap: false,
  setDiffStyle: (diffStyle) => set({ diffStyle }),
  toggleWrap: () => set((state) => ({ wrap: !state.wrap })),
}));
