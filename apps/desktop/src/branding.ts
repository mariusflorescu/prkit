import { app, nativeTheme } from "electron";

/** The Dock icon for each appearance: the kit's in dev, the ones the packaged build staged. */
export interface DockIcons {
  readonly light: string;
  readonly dark: string;
}

export function applyBranding(dockIcons: DockIcons) {
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    // Unset, AppKit appends the bundle's build number, which in dev is Electron's own version.
    version: "",
    credits: "Stay in the loop when agents write the code.",
  });
  // Only the dock can follow the appearance. Electron gives the macOS About panel no
  // icon option, so the panel shows the app bundle's icon.
  const followAppearance = () =>
    app.dock?.setIcon(nativeTheme.shouldUseDarkColors ? dockIcons.dark : dockIcons.light);
  followAppearance();
  nativeTheme.on("updated", followAppearance);
}
