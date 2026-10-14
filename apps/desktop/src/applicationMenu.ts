import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

/** Opens the Settings tab in the window the menu acted on: the focused one, or one a caller passes. */
const settings: MenuItemConstructorOptions = {
  id: "settings",
  label: "Settings…",
  accelerator: "CmdOrCtrl+,",
  click: (_item, window) => {
    if (window instanceof BrowserWindow) window.webContents.send("prkit:open-settings");
  },
};

export function installApplicationMenu(actions: { readonly checkForUpdates: () => void }) {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "prkit",
            submenu: [
              { role: "about" as const },
              {
                id: "check-for-updates",
                label: "Check for Updates…",
                click: actions.checkForUpdates,
              },
              { type: "separator" as const },
              settings,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { role: "close", accelerator: "Shift+CmdOrCtrl+W" },
        ...(process.platform === "darwin" ? [] : [{ role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
