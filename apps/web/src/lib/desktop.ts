import type { ThemePreference } from "@prkit/contracts";

/** A PR's tab to open from a notification click: Guide, unless it says Fixes. */
export interface GuideTarget {
  readonly key: string;
  readonly accountId: string;
  readonly tab?: "guide" | "fixes";
}

export interface PrkitDesktopBridge {
  readonly platform: string;
  readonly isDesktop: true;
  readonly onOpenSettings: (callback: () => void) => () => void;
  /** A macOS notification; clicking it focuses the window and calls `onOpenGuide`. */
  readonly notify: (
    notification: GuideTarget & { readonly title: string; readonly body: string },
  ) => void;
  readonly onOpenGuide: (callback: (target: GuideTarget) => void) => () => void;
  /** Tells the shell the chosen theme, so the title bar, menus and Dock icon follow it. */
  readonly setTheme: (theme: ThemePreference) => void;
}

declare global {
  interface Window {
    /** Set by apps/desktop's preload. Absent in a plain browser. */
    readonly prkitDesktop?: PrkitDesktopBridge;
  }
}

export const desktopBridge: PrkitDesktopBridge | undefined = window.prkitDesktop;

export const isMacDesktop = desktopBridge?.platform === "darwin";
