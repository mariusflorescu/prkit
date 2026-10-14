import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification } from "electron";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThemePreference } from "@prkit/contracts";
import { applyBranding } from "./branding.ts";
import { hydratePathFromLoginShell } from "./loginShellPath.ts";
import { createMainWindow } from "./mainWindow.ts";
import { startServer, type ServerTarget } from "./serverProcess.ts";
import { installApplicationMenu } from "./applicationMenu.ts";

// Set by scripts/dev-runner.ts for `dev:desktop`: load the Vite URL, and pin the
// server port that Vite proxies /ws to.
const devWebUrl = process.env.PRKIT_DEV_WEB_URL;
const devServerPort = Number(process.env.PRKIT_SERVER_PORT ?? 0);

app.setName("prkit");

let server: NodeChildProcess.ChildProcess | undefined;
let windowOptions: Parameters<typeof createMainWindow>[0] | undefined;
let quitting = false;

const GuideNotification = Schema.Struct({
  key: Schema.String,
  accountId: Schema.String,
  /** The PR tab a click opens; Guide when absent. */
  tab: Schema.optionalKey(Schema.Literals(["guide", "fixes"])),
  title: Schema.String,
  body: Schema.String,
});
const decodeNotification = Schema.decodeUnknownOption(GuideNotification);
const decodeTheme = Schema.decodeUnknownOption(ThemePreference);
// Held until clicked or closed, so the click handler outlives a garbage collection.
const shown = new Set<Notification>();

/** Brings a window forward (a new one if all were closed) and opens a PR's Guide (or Fixes) tab in it. */
const openGuide = (target: {
  readonly key: string;
  readonly accountId: string;
  readonly tab?: "guide" | "fixes";
}) => {
  const existing = BrowserWindow.getAllWindows()[0];
  const window = existing ?? (windowOptions ? createMainWindow(windowOptions) : undefined);
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const send = () => window.webContents.send("prkit:open-guide", target);
  if (existing === undefined || window.webContents.isLoading())
    window.webContents.once("did-finish-load", send);
  else send();
};

// "Guide ready" or "Fixes ready" from the UI: only the app's own page may ask, and only for this shape.
ipcMain.on("prkit:notify", (event, payload) => {
  const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
  if (windowOptions === undefined || origin !== windowOptions.url.origin) return;
  const notification = decodeNotification(payload);
  if (Option.isNone(notification) || !Notification.isSupported()) return;
  const { key, accountId, tab, title, body } = notification.value;
  const native = new Notification({ title, body });
  shown.add(native);
  native.on("click", () => {
    shown.delete(native);
    openGuide({ key, accountId, ...(tab === undefined ? {} : { tab }) });
  });
  native.on("close", () => shown.delete(native));
  native.show();
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
  dialog.showErrorBox("prkit could not start", message);
  app.quit();
};

async function boot() {
  applyBranding();
  installApplicationMenu();
  const appPath = app.getAppPath();
  const token = NodeCrypto.randomBytes(32).toString("hex");
  // Before the server child exists: it inherits PATH through childEnv, and a Dock launch has only launchd's.
  process.stdout.write(`[desktop] PATH ${await hydratePathFromLoginShell()}\n`);
  const target: ServerTarget = devWebUrl
    ? { _tag: "DevWeb", webOrigin: new URL(devWebUrl).origin }
    : { _tag: "Built", webDist: NodePath.resolve(appPath, "../web/dist") };

  const started = await startServer({
    entry: NodePath.resolve(appPath, "../server/dist/bin.mjs"),
    home: process.env.PRKIT_HOME ?? NodePath.join(NodeOS.homedir(), ".prkit"),
    token,
    port: devWebUrl ? devServerPort : 0,
    target,
  });
  server = started.child;
  server.once("exit", (code, signal) => {
    if (!quitting) fail(`The prkit server stopped unexpectedly (${signal ?? `code ${code}`}).`);
  });

  // Before the window exists, so it opens in the stored theme with no flash of the other one.
  nativeTheme.themeSource = started.ready.theme;

  const url = new URL(devWebUrl ?? started.ready.url);
  url.searchParams.set("token", token);
  windowOptions = { url, preload: NodePath.join(appPath, "dist-electron/preload.cjs") };
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

app.on("will-quit", () => {
  quitting = true;
  // Only the child this process spawned, by its handle.
  server?.kill("SIGTERM");
});

app
  .whenReady()
  .then(boot)
  .catch((error: Error) => fail(error.message));
