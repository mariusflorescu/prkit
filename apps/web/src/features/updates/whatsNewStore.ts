import type { ReleaseNotes } from "@prkit/contracts";
import { create } from "zustand";

interface WhatsNewContent {
  readonly title: string;
  readonly notes: ReleaseNotes;
  readonly releasesUrl: string | null;
}

/** The What's new dialog a toast's action opens. */
export const useWhatsNewDialog = create<{
  content: WhatsNewContent | null;
  show: (content: WhatsNewContent) => void;
  close: () => void;
}>((set) => ({
  content: null,
  show: (content) => set({ content }),
  close: () => set({ content: null }),
}));
