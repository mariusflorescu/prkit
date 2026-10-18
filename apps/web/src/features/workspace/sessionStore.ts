import { type OpenPullRequest, PullRequestKey, type WorkspaceCommand } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { type FileFilter, NO_FILE_FILTER } from "~/features/pullRequest/fileFilter";
import {
  FIRST_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "~/features/settings/settingsSections";

export const PullRequestTab = Schema.Literals(["conversation", "files", "guide", "fixes"]);
export type PullRequestTab = typeof PullRequestTab.Type;
type ViewMemory = {
  tab: PullRequestTab;
  scroll: Partial<Record<PullRequestTab, number>>;
  filesFilter: FileFilter;
};

/**
 * The Settings tab: whether it is in the strip, the section it shows, and the PR tab it was
 * opened from (null for the Inbox), where closing it goes back to.
 */
type SettingsTab = { open: boolean; section: SettingsSectionId; returnKey: PullRequestKey | null };

// sessionStorage, so a reload keeps the tab and a relaunch (a new origin) starts without it.
const SETTINGS_TAB_KEY = "prkit.settingsTab";
const readSettingsTab = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      open: Schema.Boolean,
      section: Schema.String,
      returnKey: Schema.NullOr(PullRequestKey),
    }),
  ),
);
const restoreSettingsTab = (): SettingsTab => {
  const saved = Option.getOrNull(readSettingsTab(window.sessionStorage.getItem(SETTINGS_TAB_KEY)));
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === saved?.section);
  return {
    open: saved?.open ?? false,
    section: section?.id ?? FIRST_SETTINGS_SECTION.id,
    returnKey: saved?.returnKey ?? null,
  };
};

/** A closed tab Cmd+Shift+T can bring back: a PR, or Settings. */
type ClosedTab = OpenPullRequest | "settings";

type Session = {
  closed: readonly ClosedTab[];
  views: Partial<Record<PullRequestKey, ViewMemory>>;
  paletteOpen: boolean;
  paletteMode: "all" | "open-pr";
  settingsTab: SettingsTab;
  failed: { command: WorkspaceCommand; message: string } | null;
  rememberTab: (key: PullRequestKey, tab: PullRequestTab) => void;
  rememberScroll: (key: PullRequestKey, tab: PullRequestTab, top: number) => void;
  rememberFilesFilter: (key: PullRequestKey, filter: FileFilter) => void;
  setPaletteOpen: (open: boolean, mode?: "all" | "open-pr") => void;
  rememberClosed: (tab: ClosedTab) => void;
  setSettingsTab: (change: Partial<SettingsTab>) => void;
};
const viewOf = (state: Session, key: PullRequestKey): ViewMemory =>
  state.views[key] ?? { tab: "files", scroll: {}, filesFilter: NO_FILE_FILTER };

export const useWorkspaceSession = create<Session>((set) => ({
  closed: [],
  views: {},
  paletteOpen: false,
  paletteMode: "all",
  settingsTab: restoreSettingsTab(),
  failed: null,
  rememberTab: (key, tab) =>
    set((state) => ({
      views: { ...state.views, [key]: { ...viewOf(state, key), tab } },
    })),
  rememberScroll: (key, tab, top) =>
    set((state) => ({
      views: {
        ...state.views,
        [key]: {
          ...viewOf(state, key),
          tab,
          scroll: { ...state.views[key]?.scroll, [tab]: top },
        },
      },
    })),
  rememberFilesFilter: (key, filesFilter) =>
    set((state) => ({
      views: { ...state.views, [key]: { ...viewOf(state, key), filesFilter } },
    })),
  setPaletteOpen: (paletteOpen, paletteMode = "all") => set({ paletteOpen, paletteMode }),
  rememberClosed: (tab) => set((state) => ({ closed: [...state.closed, tab].slice(-30) })),
  setSettingsTab: (change) =>
    set((state) => ({ settingsTab: { ...state.settingsTab, ...change } })),
}));

useWorkspaceSession.subscribe((state, previous) => {
  if (state.settingsTab !== previous.settingsTab)
    window.sessionStorage.setItem(SETTINGS_TAB_KEY, JSON.stringify(state.settingsTab));
});

export const readViewMemory = (key: PullRequestKey) => useWorkspaceSession.getState().views[key];
