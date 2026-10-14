import { create } from "zustand";

export const usePrViewStore = create<{
  order: "newest" | "oldest";
  showTree: boolean;
  toggleOrder: () => void;
  toggleTree: () => void;
}>((set) => ({
  order: "newest",
  showTree: true,
  toggleOrder: () => set((state) => ({ order: state.order === "newest" ? "oldest" : "newest" })),
  toggleTree: () => set((state) => ({ showTree: !state.showTree })),
}));
