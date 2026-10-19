import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BrowserWindow, nativeTheme, shell } from "electron";

// The web shell's title bar row is 52px, never less than 28pt on screen when the page is zoomed
// out (--title-bar-height in apps/web/src/index.css); the traffic lights sit centred in it.
const TOPBAR_HEIGHT = 52;
const MIN_TOPBAR_POINTS = 28;
const MAC_WINDOW_BUTTON_RADIUS = 7;

/** Where the traffic lights go for a page zoom: they keep their size while the title bar scales. */
const windowButtonPosition = (zoom: number) => ({
  x: 16,
  y: Math.round(Math.max(TOPBAR_HEIGHT * zoom, MIN_TOPBAR_POINTS) / 2 - MAC_WINDOW_BUTTON_RADIUS),
});

const decodeZoom = Schema.decodeUnknownOption(Schema.Finite);

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
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: windowButtonPosition(1) }
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

  // This window's preload reports the page's zoom before its first paint and on every change.
  // Electron's own redraws of the lights skip full screen, but setting their position redraws
  // them at once, so in full screen the new position waits for the exit.
  if (process.platform === "darwin") {
    let zoom = 1;
    const placeWindowButtons = () => {
      if (!window.isFullScreen()) window.setWindowButtonPosition(windowButtonPosition(zoom));
    };
    window.webContents.ipc.on("prkit:page-zoom", (_event, payload) => {
      const reported = decodeZoom(payload);
      if (Option.isNone(reported)) return;
      // Chromium's page zoom runs from 25% to 500%.
      zoom = Math.min(Math.max(reported.value, 0.25), 5);
      placeWindowButtons();
    });
    window.on("leave-full-screen", placeWindowButtons);
  }

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
