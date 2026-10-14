import { BrowserWindow, nativeTheme, shell } from "electron";

// The web shell's title bar row is 52px; the traffic lights sit centred in it.
const TOPBAR_HEIGHT = 52;
const MAC_WINDOW_BUTTON_RADIUS = 7;

// The frame's color (--frame in apps/web/src/index.css), so the window opens in the splash's color.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#15110d" : "#f2eee9");

const isWebUrl = (url: string): boolean => {
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
};

const openExternally = (url: string) => {
  if (isWebUrl(url)) void shell.openExternal(url);
};

export function createMainWindow(options: { readonly url: URL; readonly preload: string }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "prkit",
    backgroundColor: windowBackground(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: TOPBAR_HEIGHT / 2 - MAC_WINDOW_BUTTON_RADIUS },
        }
      : {}),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const followTheme = () => window.setBackgroundColor(windowBackground());
  nativeTheme.on("updated", followTheme);
  window.once("closed", () => nativeTheme.off("updated", followTheme));
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (URL.parse(url)?.origin === options.url.origin) return;
    event.preventDefault();
    openExternally(url);
  });

  void window.loadURL(options.url.toString());
  return window;
}
