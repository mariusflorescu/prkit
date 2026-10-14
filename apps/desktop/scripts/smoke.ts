/**
 * Launches the built desktop app, checks the UI talked to its server, saves a
 * screenshot, and checks quitting stops the server child. Exits non-zero on any
 * failure. Run `vp run build` first.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { childEnv } from "@prkit/contracts";
import { _electron as electron } from "playwright";

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "../..");
const evidenceDir = NodePath.join(repoRoot, ".e2e/evidence");
const screenshotPath = NodePath.join(evidenceDir, "desktop-smoke.png");
const smokeHome = NodePath.join(repoRoot, ".e2e/smoke-home");

const step = (message: string) => process.stdout.write(`[smoke] ${message}\n`);

/** Observes (never kills) the server child Electron spawned: its direct child running the server bundle. */
const serverChildPids = (electronPid: number): Array<number> =>
  NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) return [];
      const [, pid, ppid, command] = match;
      return Number(ppid) === electronPid && command?.includes("server/dist/bin.mjs")
        ? [Number(pid)]
        : [];
    });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const required of [
  "dist-electron/main.cjs",
  "../server/dist/bin.mjs",
  "../web/dist/index.html",
]) {
  if (!NodeFS.existsSync(NodePath.join(desktopDir, required))) {
    process.stderr.write(`[smoke] missing ${required}; run \`vp run build\` first\n`);
    process.exit(1);
  }
}
NodeFS.mkdirSync(evidenceDir, { recursive: true });
NodeFS.rmSync(screenshotPath, { force: true });
// A previous run's notification click leaves a PR tab active, which would restore over the Inbox.
NodeFS.rmSync(smokeHome, { recursive: true, force: true });

// childEnv drops ELECTRON_RUN_AS_NODE (an agent shell may carry it) and any PRKIT_* from the caller.
// PATH is what launchd gives an app started from the Dock, so main has to rebuild it from the
// login shell for the server to find gh, git, claude and codex.
const app = await electron.launch({
  args: [desktopDir],
  env: { ...childEnv(process.env), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PRKIT_HOME: smokeHome },
  timeout: 30_000,
});
let failure: Error | undefined;
let serverPids: Array<number> = [];
try {
  const electronPid = app.process().pid;
  const window = await app.firstWindow();
  step(`window opened: ${window.url().replace(/token=[^&]+/, "token=…")}`);

  await window
    .getByRole("navigation")
    .getByText("Inbox", { exact: true })
    .waitFor({ timeout: 15_000 });
  step("tab strip shows Inbox");

  const footer = window.getByTestId("app-info");
  await footer.waitFor({ timeout: 15_000 });
  const footerText = (await footer.textContent()) ?? "";
  if (!footerText.includes("prkit") || !footerText.includes(smokeHome)) {
    throw new Error(`app.info footer has unexpected text: ${footerText}`);
  }
  step(`app.info footer: ${footerText}`);

  const cmdN = await app.evaluate(({ Menu }) => {
    const walk = (menu: Electron.Menu | null | undefined): Array<Electron.MenuItem> =>
      menu?.items.flatMap((item) => [item, ...walk(item.submenu)]) ?? [];
    return walk(Menu.getApplicationMenu())
      .filter((item) =>
        /^(CmdOrCtrl|CommandOrControl|Cmd|Command)\+N$/i.test(item.accelerator ?? ""),
      )
      .map((item) => item.label);
  });
  if (cmdN.length > 0) throw new Error(`app menu items claim Cmd+N: ${cmdN.join(", ")}`);
  await window.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
  await window.getByRole("dialog", { name: "Find a pull request" }).waitFor({ timeout: 5_000 });
  await window.keyboard.press("Escape");
  step("Cmd+N reaches the window and opens the PR palette");

  const primary = process.platform === "darwin" ? "Meta" : "Control";
  const tabs = window.getByRole("navigation", { name: "Workspace tabs" });
  const settingsTab = tabs.getByRole("link", { name: "Settings", exact: true });
  await window.keyboard.press(`${primary}+,`);
  await window.getByRole("heading", { name: "GitHub accounts" }).waitFor({ timeout: 5_000 });
  if ((await settingsTab.getAttribute("aria-current")) !== "page")
    throw new Error("Cmd+, did not open Settings as the active tab");
  step("Cmd+, opens Settings as a tab in the strip");
  await window
    .getByLabel("Loading GitHub accounts")
    .waitFor({ state: "detached", timeout: 30_000 });
  const noGh = await window.getByText(/Couldn't find gh/).count();
  if (noGh > 0)
    throw new Error("the server could not find gh: PATH was not rebuilt from the login shell");
  step("a launchd PATH still finds gh: no account reports a missing gh");
  await window.keyboard.press(`${primary}+W`);
  await settingsTab.waitFor({ state: "detached", timeout: 5_000 });

  // The app menu's Settings… (Cmd+,) sends the window the same request: it opens the tab again.
  if (process.platform === "darwin") {
    const clicked = await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("settings");
      const target = BrowserWindow.getAllWindows()[0];
      if (item === null || item === undefined || target === undefined) return null;
      item.click(undefined, target, target.webContents);
      return item.accelerator ?? "";
    });
    if (clicked !== "CmdOrCtrl+,")
      throw new Error(`the app menu has no Settings… item on Cmd+, (got ${clicked})`);
    await settingsTab.waitFor({ timeout: 5_000 });
    if ((await settingsTab.getAttribute("aria-current")) !== "page")
      throw new Error("the Settings… menu item did not open Settings as the active tab");
    await window.keyboard.press(`${primary}+W`);
    await settingsTab.waitFor({ state: "detached", timeout: 5_000 });
    step("the app menu's Settings… opens the Settings tab, and Cmd+W closes it");
  }

  if (electronPid !== undefined) serverPids = serverChildPids(electronPid);
  if (serverPids.length !== 1)
    throw new Error(`expected one server child, found ${serverPids.length}`);
  step(`electron pid ${electronPid}, server child pid ${serverPids.join(", ")}`);

  await window.screenshot({ path: screenshotPath });
  step(`screenshot saved to ${NodePath.relative(repoRoot, screenshotPath)}`);

  // "Guide ready": the page asks main for a notification; clicking it opens that PR's Guide
  // tab. `show` is replaced so the smoke never puts a real banner on the screen.
  await app.evaluate(({ Notification }) => {
    const shown: Array<InstanceType<typeof Notification>> = [];
    Reflect.set(Notification, "smokeShown", shown);
    Notification.prototype.show = function show(this: InstanceType<typeof Notification>) {
      shown.push(this);
    };
  });
  await window.evaluate(() =>
    Reflect.get(window, "prkitDesktop").notify({
      key: "github.com/octocat/prkit-fixtures#1",
      accountId: "github.com/octocat",
      title: "Guide ready",
      body: "Validate links and count clicks · 3 chapters",
    }),
  );
  const notified = await (async () => {
    for (let tries = 0; tries < 50; tries++) {
      const titles = await app.evaluate(({ Notification }) =>
        Reflect.get(Notification, "smokeShown").map((entry: { title: string }) => entry.title),
      );
      if (titles.length > 0) return titles;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  })();
  if (notified[0] !== "Guide ready")
    throw new Error(`expected a "Guide ready" notification, got ${JSON.stringify(notified)}`);
  step(`main showed the notification: ${notified[0]}`);
  await app.evaluate(({ Notification }) =>
    Reflect.get(Notification, "smokeShown")[0].emit("click"),
  );
  await window.waitForURL(/\/pr\/github\.com\/octocat\/prkit-fixtures\/1\?.*tab=guide/, {
    timeout: 15_000,
  });
  step(`clicking it opened the Guide tab: ${new URL(window.url()).pathname}`);

  // "Fixes ready" names the Fixes tab, and its click opens that one instead.
  await window.evaluate(() =>
    Reflect.get(window, "prkitDesktop").notify({
      key: "github.com/octocat/prkit-fixtures#1",
      accountId: "github.com/octocat",
      tab: "fixes",
      title: "Fixes ready",
      body: "Validate links and count clicks · 2 fixed",
    }),
  );
  for (
    let tries = 0;
    tries < 50 &&
    (await app.evaluate(({ Notification }) => Reflect.get(Notification, "smokeShown").length)) < 2;
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  await app.evaluate(({ Notification }) =>
    Reflect.get(Notification, "smokeShown")[1].emit("click"),
  );
  await window.waitForURL(/\/pr\/github\.com\/octocat\/prkit-fixtures\/1\?.*tab=fixes/, {
    timeout: 15_000,
  });
  step(`a Fixes notice opened the Fixes tab: ${new URL(window.url()).search}`);

  // Settings > Appearance: the page tells main the theme and native chrome follows it. Main
  // ignores anything that is not one of the three choices.
  const themeSource = () => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  await window.evaluate(() => Reflect.get(window, "prkitDesktop").setTheme("dark"));
  for (let tries = 0; tries < 50 && (await themeSource()) !== "dark"; tries++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await themeSource()) !== "dark")
    throw new Error(`expected nativeTheme.themeSource "dark", got "${await themeSource()}"`);
  await window.evaluate(() => Reflect.get(window, "prkitDesktop").setTheme("sepia"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if ((await themeSource()) !== "dark")
    throw new Error("main accepted a theme outside system, light and dark");
  step("setTheme moved nativeTheme.themeSource to dark and ignored an unknown theme");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  // A startup failure leaves Electron's blocking error dialog up, so close is bounded and
  // falls back to the Electron process Playwright spawned.
  const closed = await Promise.race([
    app.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!closed) app.process().kill("SIGKILL");
}

if (failure === undefined) {
  const deadline = Date.now() + 5_000;
  while (serverPids.some(isAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const survivors = serverPids.filter(isAlive);
  if (survivors.length > 0)
    failure = new Error(`server child still running after quit: ${survivors.join(", ")}`);
  else step("server child stopped on quit");
}

if (failure !== undefined) {
  process.stderr.write(`[smoke] FAILED: ${failure.message}\n`);
  process.exit(1);
}
step("passed");
