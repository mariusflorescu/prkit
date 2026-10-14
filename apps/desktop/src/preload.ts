import type { ThemePreference } from "@prkit/contracts";
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
});
