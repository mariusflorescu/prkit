/**
 * The IPC channels between the desktop shell and the page for app updates. Plain strings with
 * no imports, so the sandboxed preload can bundle them without Effect.
 */
export const DesktopUpdateIpc = {
  /** Main to page: every new update state. */
  state: "prkit:update-state",
  getState: "prkit:update-get-state",
  check: "prkit:update-check",
  download: "prkit:update-download",
  install: "prkit:update-install",
  setChannel: "prkit:update-set-channel",
  /** The page showed the "Updated to" toast, so it never shows again for that version. */
  dismissWhatsNew: "prkit:update-dismiss-whats-new",
} as const;
