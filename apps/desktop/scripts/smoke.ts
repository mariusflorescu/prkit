/**
 * Launches the built desktop app, checks the UI talked to its server, saves a
 * screenshot, and checks quitting stops the server child. Exits non-zero on any
 * failure. Run `vp run build` first.
 *
 *   node scripts/smoke.ts                      the built app in this checkout
 *   node scripts/smoke.ts --app <path to .app> a packaged app, with its own home and
 *                                              Chromium profile under .prkit/smoke-app-home
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { childEnv } from "@prkit/contracts";
import { _electron as electron } from "playwright";

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "../..");
const evidenceDir = NodePath.join(repoRoot, ".e2e/evidence");

const { values } = NodeUtil.parseArgs({ options: { app: { type: "string" } } });
const appBundle = values.app === undefined ? undefined : NodePath.resolve(values.app);
const screenshotPath = NodePath.join(
  evidenceDir,
  appBundle === undefined ? "desktop-smoke.png" : "desktop-smoke-app.png",
);
const smokeHome = NodePath.join(
  repoRoot,
  appBundle === undefined ? ".e2e/smoke-home" : ".prkit/smoke-app-home",
);

/** A Dock-like PATH has these only once main rebuilt it from the login shell. */
const TOOLS = ["gh", "git", "claude", "codex"];
/** Within this long of launch, a module the package left out would have failed to load. */
const MODULE_CHECK_MS = 8_000;

/** The bundle's executable, as Finder would launch it. */
const bundleExecutable = (bundle: string) =>
  NodePath.join(
    bundle,
    "Contents/MacOS",
    NodeChildProcess.execFileSync(
      "plutil",
      ["-extract", "CFBundleExecutable", "raw", NodePath.join(bundle, "Contents/Info.plist")],
      { encoding: "utf8" },
    ).trim(),
  );

const findOnPath = (tool: string, path: string) =>
  path
    .split(":")
    .filter((dir) => dir !== "")
    .map((dir) => NodePath.join(dir, tool))
    .find((candidate) => {
      try {
        NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

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

const required =
  appBundle === undefined
    ? ["dist-electron/main.cjs", "../server/dist/bin.mjs", "../web/dist/index.html"].map((file) =>
        NodePath.join(desktopDir, file),
      )
    : [NodePath.join(appBundle, "Contents/Info.plist")];
for (const file of required) {
  if (!NodeFS.existsSync(file)) {
    process.stderr.write(
      `[smoke] missing ${NodePath.relative(repoRoot, file)}; ${appBundle === undefined ? "run `vp run build` first" : "pass a packaged .app"}\n`,
    );
    process.exit(1);
  }
}
NodeFS.mkdirSync(evidenceDir, { recursive: true });
NodeFS.rmSync(screenshotPath, { force: true });
// A previous run's notification click leaves a PR tab active, which would restore over the Inbox.
NodeFS.rmSync(smokeHome, { recursive: true, force: true });

// childEnv drops ELECTRON_RUN_AS_NODE (an agent shell may carry it) and any PRKIT_* from the caller.
// PATH is what launchd gives an app started from the Dock, so main has to rebuild it from the
// login shell for the server to find gh, git, claude and codex. The Chromium profile stays in the
// smoke home too, away from an installed prkit's: a packaged app takes `--user-data-dir`, and a
// dev run, which ignores it for the `prkit Dev` profile every dev run shares, gets its own macOS
// home folder.
const launchedAt = Date.now();
const app = await electron.launch({
  ...(appBundle === undefined
    ? { args: [desktopDir] }
    : {
        executablePath: bundleExecutable(appBundle),
        args: [`--user-data-dir=${NodePath.join(smokeHome, "electron")}`],
      }),
  env: {
    ...childEnv(process.env),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PRKIT_HOME: smokeHome,
    ...(appBundle === undefined ? { CFFIXED_USER_HOME: NodePath.join(smokeHome, "user") } : {}),
  },
  timeout: 30_000,
});
let output = "";
app.process().stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
app.process().stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
let failure: Error | undefined;
let serverPids: Array<number> = [];
try {
  const electronPid = app.process().pid;
  const window = await app.firstWindow();
  step(`window opened: ${window.url().replace(/token=[^&]+/, "token=…")}`);
  if (appBundle !== undefined) {
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
    if (!appPath.startsWith(appBundle))
      throw new Error(`expected the app to run from ${appBundle}, it runs from ${appPath}`);
    step(`runs the packaged app: ${NodePath.relative(appBundle, appPath)}`);
  }
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  if (!userData.startsWith(smokeHome))
    throw new Error(`the Chromium profile is ${userData}, outside the smoke home`);

  await window
    .getByRole("navigation")
    .getByText("Inbox", { exact: true })
    .waitFor({ timeout: 15_000 });
  step("tab strip shows Inbox");

  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, launchedAt + MODULE_CHECK_MS - Date.now())),
  );
  const missingModule = /MODULE_NOT_FOUND|Cannot find (module|package)/.exec(output);
  if (missingModule !== null)
    throw new Error(`a module failed to load within ${MODULE_CHECK_MS / 1000}s: ${output}`);
  step(`no MODULE_NOT_FOUND within ${MODULE_CHECK_MS / 1000}s of launch`);

  // Main rebuilt its own PATH before it started the server, which inherits it.
  const hydrated = await app.evaluate(() => process.env.PATH ?? "");
  for (const tool of TOOLS) {
    const found = findOnPath(tool, hydrated);
    if (found !== undefined) step(`${tool} resolves from the rebuilt PATH: ${found}`);
    else if (findOnPath(tool, process.env.PATH ?? "") !== undefined)
      throw new Error(`${tool} is on this shell's PATH but not on the PATH main rebuilt`);
    else step(`${tool} is not installed on this machine; skipped`);
  }

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
  if (appBundle !== undefined) {
    // From the Dock the app's own working directory is `/`; the server runs in the home folder.
    const cwd = NodeChildProcess.execFileSync(
      "lsof",
      ["-a", "-p", String(serverPids[0]), "-d", "cwd", "-Fn"],
      { encoding: "utf8" },
    )
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (cwd !== NodeOS.homedir()) throw new Error(`the server runs in ${cwd}, not the home folder`);
    step("the packaged server runs in the home folder");
  }

  // View > Zoom In and Zoom Out scale the page and the title bar with it, while macOS draws the
  // traffic lights at one size. At every step the menu offers, the lights sit centred in the
  // title bar, left of the brand mark and above the page.
  if (process.platform === "darwin") {
    const pixelRatio = () => window.evaluate(() => devicePixelRatio);
    const titleBarProblems = async () => {
      const native = await app.evaluate(({ BrowserWindow, screen }) => {
        const target = BrowserWindow.getAllWindows()[0];
        return target === undefined
          ? null
          : {
              lights: target.getWindowButtonPosition(),
              scale: screen.getDisplayMatching(target.getBounds()).scaleFactor,
            };
      });
      const page = await window.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect === undefined
            ? null
            : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        return {
          ratio: devicePixelRatio,
          bar: box("[data-workspace-tabbar]"),
          brand: box('[data-workspace-tabbar] svg[aria-label="prkit"]'),
          panel: box("[data-workspace-panel]"),
        };
      });
      if (native === null || native.lights === null || !page.bar || !page.brand || !page.panel)
        return {
          percent: 0,
          problems: ["the window, its traffic lights or the title bar is missing"],
        };
      const factor = page.ratio / native.scale;
      const points = (value: number) => Math.round(value * factor * 10) / 10;
      // macOS draws three 14pt buttons, 20pt apart, from the position the window reports.
      const lights = {
        right: native.lights.x + 54,
        top: native.lights.y,
        bottom: native.lights.y + 14,
      };
      const bar = { top: points(page.bar.top), bottom: points(page.bar.bottom) };
      const problems = [
        ...(lights.right + 8 > points(page.brand.left)
          ? [
              `the lights end at ${lights.right}pt, the brand mark starts at ${points(page.brand.left)}pt`,
            ]
          : []),
        ...(lights.bottom > points(page.panel.top)
          ? [`the lights end at ${lights.bottom}pt, the page starts at ${points(page.panel.top)}pt`]
          : []),
        ...(Math.abs(lights.top + lights.bottom - bar.top - bar.bottom) / 2 > 1
          ? [
              `the lights span ${lights.top}-${lights.bottom}pt in a title bar of ${bar.top}-${bar.bottom}pt`,
            ]
          : []),
      ];
      return { percent: Math.round(factor * 100), problems };
    };
    // Main places the lights once the page reports its new zoom, a moment after the page scales.
    const settled = async () => {
      let state = await titleBarProblems();
      for (let tries = 0; tries < 20 && state.problems.length > 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await titleBarProblems();
      }
      return state;
    };
    /** Presses a zoom item; false when the page didn't scale within two seconds. */
    const zoomed = async (role: "zoomin" | "zoomout" | "resetzoom") => {
      const before = await pixelRatio();
      const pressed = await app.evaluate(({ BrowserWindow, Menu }, wanted) => {
        const walk = (menu: Electron.Menu | null | undefined): Array<Electron.MenuItem> =>
          menu?.items.flatMap((item) => [item, ...walk(item.submenu)]) ?? [];
        const item = walk(Menu.getApplicationMenu()).find(
          (entry) => entry.role?.toLowerCase() === wanted,
        );
        const target = BrowserWindow.getAllWindows()[0];
        if (item === undefined || target === undefined) return false;
        item.click(undefined, target, target.webContents);
        return true;
      }, role);
      if (!pressed) throw new Error(`the View menu has no ${role} item`);
      for (let tries = 0; tries < 20; tries++) {
        if ((await pixelRatio()) !== before) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    const check = async () => {
      const state = await settled();
      if (state.problems.length > 0)
        throw new Error(`at ${state.percent}% zoom: ${state.problems.join("; ")}`);
      return state.percent;
    };
    // The menu's range ends at Chromium's 25% and 500%, where a press no longer scales the page.
    const checked = [await check()];
    for (const direction of ["zoomout", "zoomin"] as const) {
      for (let steps = 0; steps < 40 && (await zoomed(direction)); steps++)
        checked.push(await check());
      if (!(await zoomed("resetzoom"))) throw new Error(`Actual Size did not undo ${direction}`);
    }
    if (Math.min(...checked) !== 25 || Math.max(...checked) !== 500)
      throw new Error(`the View menu's zoom stopped short: ${checked.join(", ")}%`);
    step(
      `at every zoom the View menu offers (${checked.sort((a, b) => a - b).join(", ")}%), the traffic lights sit centred in the title bar, clear of the brand mark and the page`,
    );
  }

  await window.screenshot({ path: screenshotPath });
  step(`screenshot saved to ${NodePath.relative(repoRoot, screenshotPath)}`);

  // Settings > About > Show log file: main reveals the server's own log, which holds its
  // startup lines by now. `showItemInFolder` is replaced so the smoke never opens Finder.
  await app.evaluate(({ shell }) => {
    const revealed: Array<string> = [];
    Reflect.set(shell, "smokeRevealed", revealed);
    shell.showItemInFolder = (path) => {
      revealed.push(path);
    };
  });
  await window.evaluate(() => Reflect.get(window, "prkitDesktop").showServerLog());
  const serverLog = NodePath.join(smokeHome, "logs", "server.log");
  const revealed = await (async () => {
    for (let tries = 0; tries < 50; tries++) {
      const paths: Array<string> = await app.evaluate(({ shell }) =>
        Reflect.get(shell, "smokeRevealed"),
      );
      if (paths.length > 0) return paths;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  })();
  if (revealed[0] !== serverLog)
    throw new Error(
      `expected Show log file to reveal ${serverLog}, got ${JSON.stringify(revealed)}`,
    );
  if (!NodeFS.readFileSync(serverLog, "utf8").includes("prkit server listening"))
    throw new Error("the server log has no startup line");
  step(`Show log file revealed ${NodePath.relative(repoRoot, serverLog)}`);

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
      target: {
        kind: "pull-request",
        key: "github.com/octocat/prkit-fixtures#1",
        accountId: "github.com/octocat",
      },
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
      target: {
        kind: "pull-request",
        key: "github.com/octocat/prkit-fixtures#1",
        accountId: "github.com/octocat",
        tab: "fixes",
      },
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

  // A local review's "Guide ready" has no account: its click opens the local review's page.
  await window.evaluate(() =>
    Reflect.get(window, "prkitDesktop").notify({
      target: { kind: "local", key: "local:0123456789abcdef" },
      title: "Guide ready",
      body: "widgets · feature/limits · 1 chapter",
    }),
  );
  for (
    let tries = 0;
    tries < 50 &&
    (await app.evaluate(({ Notification }) => Reflect.get(Notification, "smokeShown").length)) < 3;
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  await app.evaluate(({ Notification }) =>
    Reflect.get(Notification, "smokeShown")[2].emit("click"),
  );
  await window.waitForURL(/\/local\/local(:|%3A)0123456789abcdef$/, { timeout: 15_000 });
  step(`a local review's notice opened its page: ${new URL(window.url()).pathname}`);

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
  const tail = output.split("\n").slice(-40).join("\n");
  process.stderr.write(`[smoke] app output, last lines:\n${tail}\n`);
  process.stderr.write(`[smoke] FAILED: ${failure.message}\n`);
  process.exit(1);
}
step("passed");
