import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import {
  KEYCHAIN_RUNS,
  KEYCHAIN_SKIP,
  holdPorts,
  listening,
  loginFiles,
  scratchCodexHome,
  signedIn,
  signInThroughFile,
  signInThroughKeychain,
  signOutOfKeychain,
} from "./codexKeychain.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import {
  emulateOsColorScheme,
  readPageTheme,
  screenshotLightAndDark,
  setOsColorScheme,
} from "./osColorScheme.ts";

const SECTIONS = [
  "Accounts",
  "Agents",
  "Guides",
  "Appearance",
  "Keyboard shortcuts",
  "About",
] as const;
/** Cmd+, (Ctrl+, off macOS), then the section's link in the Settings nav. */
const openSettingsSection = async (
  { screen, browser }: Pick<TestFixtures, "screen"> & { browser: Browser },
  name: (typeof SECTIONS)[number],
) => {
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("navigation", "Settings sections").getByRole("link", name).tap();
};

// The splash paints the window frame's color (index.css --frame) before index.css loads.
const FRAME_DARK = "rgb(21, 17, 13)";
const FRAME_LIGHT = "rgb(242, 238, 233)";

test("Settings has a section nav, opens on Accounts, and Cmd+, returns to the last section", async ({
  app,
  screen,
  browser,
}) => {
  await openInbox({ app, screen });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await expect(browser).toHaveURL("/settings/accounts");
  const sections = screen.getByRole("navigation", "Settings sections");
  await expect(sections.getByRole("link")).toHaveText([...SECTIONS]);
  await expect(sections.getByRole("link", "Accounts")).toHaveAttribute("aria-current", "page");
  await expect(screen.getByRole("region", "GitHub accounts")).toBeVisible();
  await app.screenshot("settings-accounts");

  for (const name of SECTIONS.slice(1)) {
    await sections.getByRole("link", name).tap();
    await expect(sections.getByRole("link", name)).toHaveAttribute("aria-current", "page");
  }
  await sections.getByRole("link", "Guides").tap();
  await expect(
    screen.getByRole("region", "Guides").getByRole("list", "Automatic guides by account"),
  ).toBeVisible({ timeout: 30_000 });
  await app.screenshot("settings-guides");
  await sections.getByRole("link", "Agents").tap();
  await expect(browser).toHaveURL("/settings/agents");
  await browser.keyboard.press(`${modifier}+w`);
  await expect(browser).toHaveURL("/");
  await browser.keyboard.press(`${modifier}+Comma`);
  await expect(browser).toHaveURL("/settings/agents");
  await screen
    .getByRole("navigation", "Workspace tabs")
    .getByRole("button", "Close Settings")
    .tap();
  await expect(browser).toHaveURL("/");
});

/** The Settings tab's fill, and whether it is the panel's own (the active PR tab's material). */
const settingsTabPaint = (browser: Browser) =>
  browser.evaluate(() => {
    const tab = document.querySelector("[data-settings-tab]");
    const panel = document.querySelector("[data-workspace-panel]");
    if (tab === null || panel === null) return null;
    const fill = getComputedStyle(tab).backgroundColor;
    return { fill, panel: fill === getComputedStyle(panel).backgroundColor };
  });

/** The title bar's tabs, left to right, by what each shows. */
const stripOrder = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll("[data-workspace-tabbar] [data-active-tab]")].map(
      (tab) => (tab.querySelector("[data-open-pr]") ?? tab).textContent?.trim() ?? "",
    ),
  );

test("Settings is a tab at the end of the strip: opened or focused, closed back to the tab it came from, kept on reload", async ({
  app,
  screen,
  browser,
}) => {
  // An instance of its own over the fake GitHub, so the open tabs and the theme are this journey's.
  const fake = await startFakeGitHub("settings-tab");
  try {
    const run = startFakeInstance("settings-tab", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    const tabs = screen.getByRole("navigation", "Workspace tabs");
    const settingsTab = tabs.getByRole("link", "Settings");
    const path = () => browser.evaluate(() => location.pathname);
    const pullRequestPath = (number: number) => `/pr/github.com/budget/fixtures/${number}`;
    const openPullRequest = async (number: number) => {
      await tabs.getByRole("link", "Inbox").tap();
      await screen
        .getByRole("link", new RegExp(`#${number} \\w`))
        .first()
        .tap({ timeout: 20_000 });
      await expect.poll(path).toBe(pullRequestPath(number));
    };
    await openPullRequest(1);
    await openPullRequest(2);
    await expect(settingsTab).toHaveCount(0);

    // The palette opens it after the PR tabs, on Accounts the first time, with no header row.
    await browser.keyboard.press(`${modifier}+k`);
    const palette = screen.getByRole("dialog", "Find a pull request");
    await palette.getByRole("searchbox", "Find a pull request").fill("settings");
    await palette.getByRole("button", "Settings").tap();
    await expect.poll(path).toBe("/settings/accounts");
    await expect(settingsTab).toHaveAttribute("aria-current", "page");
    await expect.poll(() => stripOrder(browser)).toEqual(["Inbox", "#1", "#2", "Settings"]);
    await expect(screen.getByRole("button", "Back")).toHaveCount(0);
    expect(await settingsTabPaint(browser)).toMatchObject({ panel: true });
    await expect(screen.getByRole("region", "GitHub accounts")).toBeVisible();
    await expect(
      screen.getByRole("region", "GitHub accounts").getByText("Ready").first(),
    ).toBeVisible({ timeout: 30_000 });
    await screenshotLightAndDark(app, browser, "settings-tab-active");

    // Every section fills the panel under the tab.
    const sections = screen.getByRole("navigation", "Settings sections");
    for (const [name, loaded] of [
      ["Accounts", screen.getByRole("region", "GitHub accounts").getByText("Ready").first()],
      ["Agents", screen.getByRole("list", "Agents").getByRole("listitem", "Codex")],
      ["Guides", screen.getByRole("list", "Automatic guides by account")],
      ["Appearance", screen.getByRole("radiogroup", "Theme")],
      ["Keyboard shortcuts", screen.getByRole("list", "General")],
      ["About", screen.getByRole("region", "About prkit").getByText(/^Build /)],
    ] as const) {
      await sections.getByRole("link", name).tap();
      await expect(loaded).toBeVisible({ timeout: 30_000 });
      await screenshotLightAndDark(
        app,
        browser,
        `settings-section-${name.toLowerCase().replace(" ", "-")}`,
      );
    }

    // Cmd+, and the palette focus the same tab rather than opening another.
    await sections.getByRole("link", "Agents").tap();
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");
    await expect(settingsTab).toHaveCount(1);

    // Switching away keeps it in the strip, on its section.
    await tabs.getByRole("link", /^Open budget\/fixtures #1/).tap();
    await expect.poll(path).toBe(pullRequestPath(1));
    await expect(settingsTab).not.toHaveAttribute("aria-current", "page");
    await expect(settingsTab).toHaveCount(1);
    await browser.mouse.move(640, 400);
    await expect
      .poll(() => settingsTabPaint(browser))
      .toEqual({ fill: "rgba(0, 0, 0, 0)", panel: false });
    await screenshotLightAndDark(app, browser, "settings-tab-inactive");
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");
    await expect(settingsTab).toHaveCount(1);

    // Its × goes back to the tab it was opened from.
    await tabs.getByRole("button", "Close Settings").tap();
    await expect.poll(path).toBe(pullRequestPath(1));
    await expect(settingsTab).toHaveCount(0);

    // Cmd+, reopens it on the section used last, and Cmd+W closes it back to the PR.
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");
    await browser.keyboard.press(`${modifier}+w`);
    await expect.poll(path).toBe(pullRequestPath(1));
    await expect(settingsTab).toHaveCount(0);
    // It was the last tab closed, so Cmd+Shift+T brings it back.
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect.poll(path).toBe("/settings/agents");
    // Close #2, then Settings, then open Settings again with Cmd+,: one Cmd+Shift+T brings
    // back #2, because the Settings tab closed after it is open again.
    await tabs.getByRole("button", "Close budget/fixtures #2").tap();
    await expect(tabs.getByRole("link", /^Open budget\/fixtures #2/)).toHaveCount(0);
    await browser.keyboard.press(`${modifier}+w`);
    await expect.poll(path).toBe(pullRequestPath(1));
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect.poll(path).toBe(pullRequestPath(2));
    await expect(settingsTab).toHaveCount(1);
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");

    // A reload keeps it open and showing.
    await browser.reload();
    await expect(settingsTab).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
    await expect.poll(path).toBe("/settings/agents");
    await expect.poll(() => stripOrder(browser)).toEqual(["Inbox", "#1", "#2", "Settings"]);
    // Ctrl+Tab counts it as the last tab: from Settings to the Inbox, back to Settings.
    await browser.keyboard.press("Control+Tab");
    await expect.poll(path).toBe("/");
    await browser.keyboard.press("Control+Shift+Tab");
    await expect.poll(path).toBe("/settings/agents");
    // Cmd+3 is the second PR tab; Settings has no number.
    await browser.keyboard.press(`${modifier}+3`);
    await expect.poll(path).toBe(pullRequestPath(2));
    // A reload with Settings in the background keeps it there, on its section.
    await browser.reload();
    await expect(screen.getByRole("heading", "Budget fixture 2")).toBeVisible({ timeout: 20_000 });
    await expect(settingsTab).toHaveCount(1);
    await expect(settingsTab).not.toHaveAttribute("aria-current", "page");
    await settingsTab.tap();
    await expect.poll(path).toBe("/settings/agents");
    // Closing it once the PR it came from is gone lands on the Inbox.
    await tabs.getByRole("link", /^Open budget\/fixtures #2/).tap();
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect.poll(path).toBe("/settings/agents");
    await tabs.getByRole("button", "Close budget/fixtures #2").tap();
    await expect(tabs.getByRole("link", /^Open budget\/fixtures #2/)).toHaveCount(0);
    // A middle click closes it, like a PR tab.
    await browser.evaluate(() => {
      document
        .querySelector("[data-settings-tab]")
        ?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      return true;
    });
    await expect(settingsTab).toHaveCount(0);
    await expect.poll(path).toBe("/");

    // Many PR tabs overflow the strip; the Settings tab stays last and scrolls into view.
    for (const number of [2, 3, 4, 5, 6]) await openPullRequest(number);
    await browser.setViewport({ width: 540, height: 600 });
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect(settingsTab).toHaveAttribute("aria-current", "page");
    await expect(screen.getByRole("button", "Scroll tabs left")).toBeEnabled();
    await expect
      .poll(() => stripOrder(browser))
      .toEqual(["Inbox", "#1", "#2", "#3", "#4", "#5", "#6", "Settings"]);
    // Inside the strip's scrolled viewport, not cut off at its edge, once the scroll buttons
    // have narrowed the strip.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const viewport = document.querySelector("[data-workspace-tab-viewport]");
          const tab = document.querySelector("[data-settings-tab]");
          if (viewport === null || tab === null) return false;
          const outer = viewport.getBoundingClientRect();
          const inner = tab.getBoundingClientRect();
          return inner.left >= outer.left && inner.right <= outer.right;
        }),
      )
      .toBe(true);
    await browser.mouse.move(270, 400);
    await screenshotLightAndDark(app, browser, "settings-tab-overflow");
  } finally {
    stopFakeInstance("settings-tab", { keepHome: false });
    fake.stop();
  }
});

test("Settings > Agents shows each agent's sign-in and keeps the default agent", async ({
  app,
  screen,
  browser,
}) => {
  await openInbox({ app, screen });
  await openSettingsSection({ screen, browser }, "Agents");
  const agents = screen.getByRole("region", "Agents");
  const list = agents.getByRole("list", "Agents");
  // Each kind's default instance, Claude first. Instances other journeys add come after them.
  const claude = list.getByRole("listitem", "Claude");
  const codex = list.getByRole("listitem", "Codex");
  await expect(claude).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole("listitem").first()).toHaveAttribute("data-instance", "claude");
  await expect(codex).toHaveAttribute("data-instance", "codex");
  await expect(claude.getByRole("status", "Claude status")).not.toHaveText("Checking…", {
    timeout: 30_000,
  });
  await expect(claude.getByRole("button", "Remove")).toHaveCount(0);
  await expect(claude.getByRole("button", "Reset to default")).toBeVisible();
  await expect(agents.getByRole("button", /^Agent and model: /)).toBeVisible();
  await agents.getByRole("button", "Check again").tap();
  await expect(codex).toBeVisible();
  await app.screenshot("settings-agents");
});

test("Escape in Settings closes only an open popup, never the Settings tab", async ({
  app,
  screen,
  browser,
}) => {
  await openInbox({ app, screen });
  await openSettingsSection({ screen, browser }, "Agents");
  await screen
    .getByRole("region", "Agents")
    .getByRole("button", /^Agent and model: /)
    .tap({ timeout: 30_000 });
  const list = screen.getByRole("dialog");
  await expect(list.getByRole("combobox", "Search models")).toBeFocused();
  await browser.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(browser).toHaveURL("/settings/agents");
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+k`);
  const palette = screen.getByRole("dialog", "Find a pull request");
  await expect(palette.getByRole("searchbox", "Find a pull request")).toBeFocused();
  await browser.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(browser).toHaveURL("/settings/agents");
  // Settings is a tab, not a dialog: with nothing open, Escape leaves it where it is.
  await browser.keyboard.press("Escape");
  await expect(browser).toHaveURL("/settings/agents");
  const tabs = screen.getByRole("navigation", "Workspace tabs");
  await expect(tabs.getByRole("link", "Settings")).toHaveAttribute("aria-current", "page");
  await browser.keyboard.press(`${modifier}+w`);
  await expect(browser).toHaveURL("/");
  await expect(tabs.getByRole("link", "Settings")).toHaveCount(0);
});

test("Settings > Agents signs Codex in for prkit when its own login is in the keychain", async ({
  app,
  screen,
  browser,
}) => {
  test.skip(!KEYCHAIN_RUNS, KEYCHAIN_SKIP);
  const home = scratchCodexHome();
  const prkitCodexHome = NodePath.join(runForUrl(app.baseUrl).home, "codex");
  await openInbox({ app, screen });
  await openSettingsSection({ screen, browser }, "Agents");
  const agents = screen.getByRole("region", "Agents");
  const codex = agents.getByRole("list", "Agents").getByRole("listitem", "Codex");
  await expect(codex).toContainText("Codex isn't signed in", { timeout: 30_000 });
  signInThroughKeychain(home);
  try {
    await agents.getByRole("button", "Check again").tap();
    await expect(codex).toContainText(
      "Codex keeps its login in the keychain. Sign in once for prkit.",
      { timeout: 30_000 },
    );
    // The same sign-in in a terminal, for when the browser one fails.
    await expect(codex).toContainText(`CODEX_HOME='${prkitCodexHome}' codex login`);
    // No link into the user's Codex home, and a config that only keeps prkit's login in the keychain.
    expect(loginFiles(prkitCodexHome)).toEqual({
      authJson: "absent",
      config: 'cli_auth_credentials_store = "keyring"\n',
    });
    await app.screenshot("settings-agents-codex-keychain");

    // The browser sign-in starts in prkit's own Codex home. The page isn't opened here.
    await browser.evaluate(() => {
      window.open = () => null;
      return null;
    });
    await codex.getByRole("button", "Sign in for prkit").tap();
    const signingIn = codex.getByRole("status", "Signing in for prkit");
    const page = signingIn.getByRole("link", "Open the sign-in page");
    await expect(page).toHaveAttribute("href", /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/, {
      timeout: 30_000,
    });
    await app.screenshot("settings-agents-codex-signing-in");
    // Cancel stops Codex's login server, which waits on the page's redirect port.
    const redirect = new URL((await page.getAttribute("href")) ?? "").searchParams.get(
      "redirect_uri",
    );
    const port = Number(new URL(redirect ?? "").port);
    expect(await listening(port)).toBe(true);
    await signingIn.getByRole("button", "Cancel").tap();
    await expect(codex.getByRole("button", "Sign in for prkit")).toBeVisible();
    await expect.poll(() => listening(port), { timeout: 10_000 }).toBe(false);

    // Codex 0.162.1's login server tries 1455, then 1457. With both taken the sign-in fails,
    // says why, and keeps the terminal command; Try again starts over.
    const release = await holdPorts([1455, 1457]);
    await codex.getByRole("button", "Sign in for prkit").tap();
    const failed = codex.getByRole("alert");
    await expect(failed).toContainText(
      "Codex couldn't start the sign-in (failed to start login server: Port 127.0.0.1:",
      { timeout: 30_000 },
    );
    await expect(codex).toContainText(`CODEX_HOME='${prkitCodexHome}' codex login`);
    await app.screenshot("settings-agents-codex-sign-in-failed");
    await release();
    await failed.getByRole("button", "Try again").tap();
    await expect(page).toHaveAttribute("href", /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/, {
      timeout: 30_000,
    });
    await signingIn.getByRole("button", "Cancel").tap();
    await expect(codex.getByRole("button", "Sign in for prkit")).toBeVisible();

    // A login under prkit's own home is prkit's; signing it out leaves the user's.
    signInThroughKeychain(prkitCodexHome);
    await agents.getByRole("button", "Check again").tap();
    await expect(codex).toContainText("prkit's own Codex login isn't a ChatGPT subscription", {
      timeout: 30_000,
    });
    await codex.getByRole("button", "Sign out prkit's login").tap();
    await expect(codex).toContainText("Codex keeps its login in the keychain", {
      timeout: 30_000,
    });
    expect({ user: signedIn(home), prkit: signedIn(prkitCodexHome) }).toEqual({
      user: true,
      prkit: false,
    });

    // The same model list the Guide tab's composer opens.
    await agents.getByRole("button", /^Agent and model: /).tap();
    const list = screen.getByRole("dialog");
    const notice = list.getByRole("status", "Codex isn't ready");
    await expect(notice).toContainText("Codex keeps its login in the keychain");
    await expect(list.getByRole("button", "Sign in for prkit")).toBeVisible();
    // The frame after the list's fade-in.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const popup = document.querySelector('[role="dialog"]');
          return popup === null ? null : getComputedStyle(popup).opacity;
        }),
      )
      .toBe("1");
    await app.screenshot("picker-codex-keychain");
    await browser.keyboard.press("Escape");
    await expect(list).toBeHidden();

    // Once the user's Codex keeps its login in a file, prkit shares that and signs its own out.
    signInThroughKeychain(prkitCodexHome);
    expect(signedIn(prkitCodexHome, "keyring")).toBe(true);
    signInThroughFile(home);
    await agents.getByRole("button", "Check again").tap();
    await expect(codex).toContainText("Codex must use your ChatGPT login", { timeout: 30_000 });
    expect({
      files: loginFiles(prkitCodexHome),
      prkitKeychain: signedIn(prkitCodexHome, "keyring"),
    }).toEqual({
      files: { authJson: NodePath.join(home, "auth.json"), config: "absent" },
      prkitKeychain: false,
    });
  } finally {
    signOutOfKeychain(prkitCodexHome);
    signOutOfKeychain(home);
  }
});

test("Settings > Appearance applies System, Light and Dark at once and keeps the choice on the server", async ({
  app,
  screen,
  browser,
}) => {
  const run = runForUrl(app.baseUrl);
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  await openSettingsSection({ screen, browser }, "Appearance");
  const theme = screen.getByRole("radiogroup", "Theme");
  await expect(theme.getByRole("radio", "System")).toBeChecked();
  expect(await readPageTheme(browser)).toMatchObject({ dark: false, choice: "system" });
  await app.screenshot("appearance-system-light-os");

  // Dark chosen while the OS is light: dark at once, and stored by the server.
  await theme.getByText("Dark").tap();
  await expect(theme.getByRole("radio", "Dark")).toBeChecked();
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: true, choice: "dark" });
  await app.screenshot("appearance-dark-light-os");
  await expect
    .poll(() => readRows(run.home, "SELECT value FROM settings WHERE key = 'appearance.theme'"))
    .toEqual([{ value: '"dark"' }]);

  // A reload before the app's script runs still paints dark: the server's answer, not localStorage.
  await browser.route("**/assets/index-*.js", (route) => route.abort());
  await app.open(run.openUrl);
  await expect(screen.getByRole("img", "prkit")).toBeVisible();
  expect(await readPageTheme(browser)).toEqual({
    dark: true,
    choice: "dark",
    background: FRAME_DARK,
  });
  await app.screenshot("boot-splash-dark-light-os");
  await browser.unroute("**/assets/index-*.js");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  expect(await readPageTheme(browser)).toMatchObject({ dark: true, choice: "dark" });

  // System follows the OS while the page is open.
  await openSettingsSection({ screen, browser }, "Appearance");
  await theme.getByText("System").tap();
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false, choice: "system" });
  await setOsColorScheme(browser, "dark");
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: true });
  await app.screenshot("appearance-system-dark-os");
  await setOsColorScheme(browser, "light");
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false });

  // Light chosen while the OS is dark.
  await setOsColorScheme(browser, "dark");
  await theme.getByText("Light").tap();
  await expect(theme.getByRole("radio", "Light")).toBeChecked();
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false, choice: "light" });
  await app.screenshot("appearance-light-dark-os");
  await browser.route("**/assets/index-*.js", (route) => route.abort());
  await app.open(run.openUrl);
  await expect(screen.getByRole("img", "prkit")).toBeVisible();
  expect(await readPageTheme(browser)).toEqual({
    dark: false,
    choice: "light",
    background: FRAME_LIGHT,
  });
  await app.screenshot("boot-splash-light-dark-os");
});

test("Settings > Keyboard shortcuts lists the shortcuts the app handles", async ({
  app,
  screen,
  browser,
}) => {
  await openInbox({ app, screen });
  await openSettingsSection({ screen, browser }, "Keyboard shortcuts");
  const shortcuts = screen.getByRole("region", "Keyboard shortcuts");
  await expect(shortcuts.getByRole("list", "General").getByRole("listitem")).toHaveText([
    /^Open Settings/,
    /^Search pull requests and commands/,
  ]);
  const pullRequests = shortcuts.getByRole("list", "Pull requests").getByRole("listitem");
  await expect(pullRequests).toHaveCount(2);
  await expect(pullRequests.first()).toContainText("Open a pull request");
  await expect(pullRequests.first().getByText("N", { exact: true })).toBeVisible();
  await expect(pullRequests.first().getByText("T", { exact: true })).toBeVisible();
  const tabs = shortcuts.getByRole("list", "Tabs").getByRole("listitem");
  await expect(tabs).toHaveCount(6);
  await expect(tabs.first()).toContainText("Go to Inbox");
  await expect(tabs.nth(1)).toContainText("(Settings has no number)");
  await app.screenshot("settings-shortcuts");

  // The list is the handler's own table: every listed way to open the palette does it.
  const palette = screen.getByRole("dialog", "Find a pull request");
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  for (const shortcut of [`${modifier}+k`, `${modifier}+t`, `${modifier}+n`]) {
    await browser.keyboard.press(shortcut);
    await expect(palette.getByRole("searchbox", "Find a pull request")).toBeFocused();
    await browser.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  }
  await browser.keyboard.press(`${modifier}+w`);
  await expect(browser).toHaveURL("/");
});
