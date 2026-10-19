import type { DesktopUpdateState, ThemePreference, UpdateChannel } from "@prkit/contracts";
import { DesktopUpdateIpc } from "@prkit/contracts/desktopUpdateIpc";
import { contextBridge, ipcRenderer, webFrame } from "electron";

type GuideTarget =
  | {
      readonly kind: "pull-request";
      readonly key: string;
      readonly accountId: string;
      readonly tab?: "guide" | "fixes";
    }
  | { readonly kind: "local"; readonly key: string };

// Shape mirrors PrkitDesktopBridge in apps/web/src/lib/desktop.ts.
contextBridge.exposeInMainWorld("prkitDesktop", {
  platform: process.platform,
  isDesktop: true,
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("prkit:open-settings", listener);
    return () => ipcRenderer.removeListener("prkit:open-settings", listener);
  },
  notify: (notification: {
    readonly target: GuideTarget;
    readonly title: string;
    readonly body: string;
  }) => {
    ipcRenderer.send("prkit:notify", notification);
  },
  setTheme: (theme: ThemePreference) => {
    ipcRenderer.send("prkit:set-theme", theme);
  },
  bringForward: () => {
    ipcRenderer.send("prkit:bring-forward");
  },
  showServerLog: () => {
    ipcRenderer.send("prkit:show-server-log");
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

// View > Zoom In and Zoom Out scale the page, and its title bar with it, while macOS draws the
// traffic lights at one size. The page sizes the bar from --page-zoom (apps/web/src/index.css)
// and main centres the lights in it. The preload runs before <html> exists, so the first report
// waits for it, still before the first paint; every later zoom change resizes the page.
if (process.platform === "darwin") {
  let pageZoom: number | undefined;
  const followPageZoom = () => {
    const zoom = webFrame.getZoomFactor();
    if (zoom === pageZoom) return;
    pageZoom = zoom;
    document.documentElement.style.setProperty("--page-zoom", String(zoom));
    ipcRenderer.send("prkit:page-zoom", zoom);
  };
  new MutationObserver((_records, observer) => {
    if (document.documentElement === null) return;
    observer.disconnect();
    followPageZoom();
  }).observe(document, { childList: true });
  window.addEventListener("resize", followPageZoom);
}
