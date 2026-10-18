import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
} from "electron";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThemePreference } from "@prkit/contracts";
import { applyBranding } from "./branding.ts";
import { hydratePathFromLoginShell } from "./loginShellPath.ts";
import { createMainWindow } from "./mainWindow.ts";
import type { ServerTarget } from "./serverProcess.ts";
import { createServerSupervisor } from "./serverSupervisor.ts";
import { installApplicationMenu } from "./applicationMenu.ts";
import { startDesktopUpdates } from "./updates/startDesktopUpdates.ts";

// Set by scripts/dev-runner.ts for `dev:desktop`: load the Vite URL, and pin the
// server port that Vite proxies /ws to.
const devWebUrl = process.env.PRKIT_DEV_WEB_URL;
const devServerPort = Number(process.env.PRKIT_SERVER_PORT ?? 0);

// A packaged app is named by its bundle ("prkit", or "prkit Nightly"). A dev run keeps a
// Chromium profile of its own, so it never shares the single-instance lock with an install.
if (!app.isPackaged) {
  app.setName("prkit");
  app.setPath("userData", NodePath.join(app.getPath("appData"), "prkit Dev"));
}

// Packaged, app.asar mirrors the repository's apps/ folders (scripts/build-desktop-artifact.ts),
// so the server, web and preload paths below hold in both.
const desktopDir = app.isPackaged
  ? NodePath.join(app.getAppPath(), "apps/desktop")
  : app.getAppPath();

// The server serves the UI with Node's fs, which can't check a path inside app.asar
// (fs.promises.access fails there), so the packaged build unpacks it beside the archive.
const webDist = app.isPackaged
  ? NodePath.join(`${app.getAppPath()}.unpacked`, "apps/web/dist")
  : NodePath.resolve(desktopDir, "../web/dist");

/** The kit's macOS app icon in dev; packaged, the one the build staged for its channel. */
const dockIcon = (appearance: "light" | "dark") =>
  app.isPackaged
    ? NodePath.join(app.getAppPath(), "dock-icons", `${appearance}.png`)
    : NodePath.resolve(
        desktopDir,
        `../../assets/brand/app-icon/png/prkit-icon-macos-${appearance}-1024.png`,
      );

let server: ReturnType<typeof createServerSupervisor> | undefined;
let updates: ReturnType<typeof startDesktopUpdates> | undefined;
let windowOptions: Parameters<typeof createMainWindow>[0] | undefined;
let quitting = false;

/** What a click opens: a PR's tab (Guide when absent), or a local review's page. */
const GuideTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    key: Schema.String,
    accountId: Schema.String,
    tab: Schema.optionalKey(Schema.Literals(["guide", "fixes"])),
  }),
  Schema.Struct({ kind: Schema.Literal("local"), key: Schema.String }),
]);
const GuideNotification = Schema.Struct({
  target: GuideTarget,
  title: Schema.String,
  body: Schema.String,
});
const decodeNotification = Schema.decodeUnknownOption(GuideNotification);
const decodeTheme = Schema.decodeUnknownOption(ThemePreference);
// Held until clicked or closed, so the click handler outlives a garbage collection.
const shown = new Set<Notification>();

/** Brings a window forward, a new one if all were closed; `fresh` when it was just created. */
const bringForward = () => {
  const existing = BrowserWindow.getAllWindows()[0];
  const window = existing ?? (windowOptions ? createMainWindow(windowOptions) : undefined);
  if (window === undefined) return undefined;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return { window, fresh: existing === undefined };
};

/** Brings a window forward and opens a PR's Guide (or Fixes) tab, or a local review, in it. */
const openGuide = (target: typeof GuideTarget.Type) => {
  const forward = bringForward();
  if (forward === undefined) return;
  const { window, fresh } = forward;
  const send = () => window.webContents.send("prkit:open-guide", target);
  if (fresh || window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
};

// "Guide ready" or "Fixes ready" from the UI: only the app's own page may ask, and only for this shape.
ipcMain.on("prkit:notify", (event, payload) => {
  const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
  if (windowOptions === undefined || origin !== windowOptions.url.origin) return;
  const notification = decodeNotification(payload);
  if (Option.isNone(notification) || !Notification.isSupported()) return;
  const { target, title, body } = notification.value;
  const native = new Notification({ title, body });
  shown.add(native);
  native.on("click", () => {
    shown.delete(native);
    openGuide(target);
  });
  native.on("close", () => shown.delete(native));
  native.show();
});

// An outside agent opened a PR with focus: the page asks for its window to come forward.
ipcMain.on("prkit:bring-forward", (event) => {
  const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
  if (windowOptions === undefined || origin !== windowOptions.url.origin) return;
  // Another app has the focus when an agent asks, so macOS needs prkit to take it.
  app.focus({ steal: true });
  bringForward();
});

// Settings > Appearance: native chrome (title bar, menus, the Dock icon) follows the chosen
// theme, and `prefers-color-scheme` in the page follows it too. `system` follows macOS live.
ipcMain.on("prkit:set-theme", (event, payload) => {
  const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
  if (windowOptions === undefined || origin !== windowOptions.url.origin) return;
  const theme = decodeTheme(payload);
  if (Option.isSome(theme)) nativeTheme.themeSource = theme.value;
});

const fail = (message: string) => {
  process.stderr.write(`[desktop] could not start: ${message}\n`);
  dialog.showErrorBox("prkit could not start", message);
  app.quit();
};

async function boot() {
  applyBranding({ light: dockIcon("light"), dark: dockIcon("dark") });
  installApplicationMenu({ checkForUpdates: () => void updates?.checkFromMenu() });
  const token = NodeCrypto.randomBytes(32).toString("hex");
  // Before the server child exists: it inherits PATH through childEnv, and a Dock launch has only launchd's.
  process.stdout.write(`[desktop] PATH ${await hydratePathFromLoginShell()}\n`);
  const target: ServerTarget = devWebUrl
    ? { _tag: "DevWeb", webOrigin: new URL(devWebUrl).origin }
    : { _tag: "Built", webDist };

  const supervisor = createServerSupervisor({
    start: {
      entry: NodePath.resolve(desktopDir, "../server/dist/bin.mjs"),
      home: process.env.PRKIT_HOME ?? NodePath.join(NodeOS.homedir(), ".prkit"),
      token,
      target,
      // Launched from the Dock, the inherited working directory is `/`.
      ...(app.isPackaged ? { cwd: NodeOS.homedir(), appVersion: app.getVersion() } : {}),
    },
    onUnexpectedExit: (reason) => {
      if (!quitting) fail(`The prkit server stopped unexpectedly (${reason}).`);
    },
  });
  server = supervisor;
  const ready = await supervisor.start(devWebUrl ? devServerPort : 0);

  // Before the window exists, so it opens in the stored theme with no flash of the other one.
  nativeTheme.themeSource = ready.theme;

  const url = new URL(devWebUrl ?? ready.url);
  url.searchParams.set("token", token);
  windowOptions = { url, preload: NodePath.join(desktopDir, "dist-electron/preload.cjs") };

  updates = startDesktopUpdates({
    userDataDir: app.getPath("userData"),
    updateConfigPath: NodePath.join(process.resourcesPath, "app-update.yml"),
    allowedOrigin: () => windowOptions?.url.origin,
    stopServer: supervisor.stop,
    // An install that didn't happen: the same port when it's free, so the window's origin holds.
    restartServer: async () => {
      const restarted = await supervisor.start(ready.port).catch(() => supervisor.start(0));
      if (devWebUrl || windowOptions === undefined) return;
      const next = new URL(restarted.url);
      next.searchParams.set("token", token);
      if (next.origin === windowOptions.url.origin) return;
      windowOptions = { ...windowOptions, url: next };
      for (const window of BrowserWindow.getAllWindows()) void window.loadURL(next.toString());
    },
  });
  createMainWindow(windowOptions);
}

// On macOS, closing the window keeps the app and its server running so reviews keep
// watching; the Dock icon brings the window back. Quitting stops the server.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (windowOptions && BrowserWindow.getAllWindows().length === 0) createMainWindow(windowOptions);
});

// The updater quits the app to install. Nothing may hold the quit back, and the server
// stopping on the way out is expected.
nativeUpdater.on("before-quit-for-update", () => {
  quitting = true;
});

app.on("will-quit", () => {
  quitting = true;
  server?.signalStop();
  void updates?.dispose();
});

// `kill <pid>` on the main process quits like Cmd+Q, so the server child stops too.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => app.quit());

// A second launch of the same app focuses this one's window instead of starting another
// server. Another app on the same home (stable and nightly, or a dev run) is refused by the
// server's home lock, with a message.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => bringForward());
  app
    .whenReady()
    .then(boot)
    .catch((error: Error) => {
      // Quitting while booting stops the server on purpose; that's no failure to report.
      if (!quitting) fail(error.message);
    });
} else {
  app.quit();
}
