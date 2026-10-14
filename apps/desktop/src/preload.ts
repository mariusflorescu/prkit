import type { DesktopUpdateState, ThemePreference, UpdateChannel } from "@prkit/contracts";
import { DesktopUpdateIpc } from "@prkit/contracts/desktopUpdateIpc";
import { contextBridge, ipcRenderer } from "electron";

interface GuideTarget {
  readonly key: string;
  readonly accountId: string;
  readonly tab?: "guide" | "fixes";
}

// Shape mirrors PrkitDesktopBridge in apps/web/src/lib/desktop.ts.
contextBridge.exposeInMainWorld("prkitDesktop", {
  platform: process.platform,
  isDesktop: true,
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("prkit:open-settings", listener);
    return () => ipcRenderer.removeListener("prkit:open-settings", listener);
  },
  notify: (notification: GuideTarget & { readonly title: string; readonly body: string }) => {
    ipcRenderer.send("prkit:notify", notification);
  },
  setTheme: (theme: ThemePreference) => {
    ipcRenderer.send("prkit:set-theme", theme);
  },
  onOpenGuide: (callback: (target: GuideTarget) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: GuideTarget) => callback(target);
    ipcRenderer.on("prkit:open-guide", listener);
    return () => ipcRenderer.removeListener("prkit:open-guide", listener);
  },
  updates: {
    getState: () => ipcRenderer.invoke(DesktopUpdateIpc.getState),
    check: () => ipcRenderer.invoke(DesktopUpdateIpc.check),
    download: () => ipcRenderer.invoke(DesktopUpdateIpc.download),
    install: () => ipcRenderer.invoke(DesktopUpdateIpc.install),
    setChannel: (channel: UpdateChannel) =>
      ipcRenderer.invoke(DesktopUpdateIpc.setChannel, channel),
    dismissWhatsNew: () => ipcRenderer.invoke(DesktopUpdateIpc.dismissWhatsNew),
    onState: (callback: (state: DesktopUpdateState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) =>
        callback(state);
      ipcRenderer.on(DesktopUpdateIpc.state, listener);
      return () => ipcRenderer.removeListener(DesktopUpdateIpc.state, listener);
    },
  },
});
