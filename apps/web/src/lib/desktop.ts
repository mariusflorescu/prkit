import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ThemePreference,
  UpdateChannel,
} from "@prkit/contracts";

/** What a notification click opens: a PR's Guide (or Fixes) tab, or a local review's page. */
export type GuideTarget =
  | {
      readonly kind: "pull-request";
      readonly key: string;
      readonly accountId: string;
      readonly tab?: "guide" | "fixes";
    }
  | { readonly kind: "local"; readonly key: string };

/** The app's own updates, run by the desktop shell. Every call answers with the state after it. */
export interface DesktopUpdatesBridge {
  readonly getState: () => Promise<DesktopUpdateState>;
  readonly check: () => Promise<DesktopUpdateActionResult>;
  readonly download: () => Promise<DesktopUpdateActionResult>;
  /** Confirmed by the user first: the app quits to install and starts again. */
  readonly install: () => Promise<DesktopUpdateActionResult>;
  readonly setChannel: (channel: UpdateChannel) => Promise<DesktopUpdateActionResult>;
  /** The "Updated to" toast showed; it never shows again for this version. */
  readonly dismissWhatsNew: () => Promise<DesktopUpdateActionResult>;
  /** Every later state; returns the unsubscribe. */
  readonly onState: (callback: (state: DesktopUpdateState) => void) => () => void;
}

export interface PrkitDesktopBridge {
  readonly platform: string;
  readonly isDesktop: true;
  readonly onOpenSettings: (callback: () => void) => () => void;
  /** A macOS notification; clicking it focuses the window and calls `onOpenGuide`. */
  readonly notify: (notification: {
    readonly target: GuideTarget;
    readonly title: string;
    readonly body: string;
  }) => void;
  readonly onOpenGuide: (callback: (target: GuideTarget) => void) => () => void;
  /** Tells the shell the chosen theme, so the title bar, menus and Dock icon follow it. */
  readonly setTheme: (theme: ThemePreference) => void;
  /** Brings this window to the front, for a PR an outside agent opened with focus. */
  readonly bringForward: () => void;
  /** Reveals the server's log file in Finder, or its folder before the first line is written. */
  readonly showServerLog: () => void;
  readonly updates: DesktopUpdatesBridge;
}

declare global {
  interface Window {
    /** Set by apps/desktop's preload. Absent in a plain browser. */
    readonly prkitDesktop?: PrkitDesktopBridge;
  }
}

export const desktopBridge: PrkitDesktopBridge | undefined = window.prkitDesktop;

/** Undefined in a plain browser: there, no update UI shows at all. */
export const updatesBridge: DesktopUpdatesBridge | undefined = desktopBridge?.updates;

export const isMacDesktop = desktopBridge?.platform === "darwin";
