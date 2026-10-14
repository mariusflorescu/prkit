import * as NodePath from "node:path";

import { app, nativeTheme } from "electron";

/** The kit's macOS app icon for one appearance, resolved from the repo like the web and server builds. */
const macIcon = (appearance: "light" | "dark") =>
  NodePath.resolve(
    app.getAppPath(),
    `../../assets/brand/app-icon/png/prkit-icon-macos-${appearance}-1024.png`,
  );

export function applyBranding() {
  app.setAboutPanelOptions({
    applicationName: "prkit",
    applicationVersion: app.getVersion(),
    // Unset, AppKit appends the bundle's build number, which in dev is Electron's own version.
    version: "",
    credits: "Stay in the loop when agents write the code.",
  });
  // Only the dock can follow the appearance. Electron gives the macOS About panel no
  // icon option, so the panel shows the app bundle's icon.
  const followAppearance = () =>
    app.dock?.setIcon(macIcon(nativeTheme.shouldUseDarkColors ? "dark" : "light"));
  followAppearance();
  nativeTheme.on("updated", followAppearance);
}
