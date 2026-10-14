import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl, serverVersion } from "../scripts/verify-run.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  emulateOsColorScheme,
  readPageTheme,
  screenshotLightAndDark,
  setOsColorScheme,
} from "./osColorScheme.ts";

test("the Inbox tab stays open, Settings opens as a tab, and the palette opens from Cmd+K, Cmd+T, Cmd+N and +", async ({
  app,
  screen,
  browser,
}) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  await expect(browser.locator('[aria-label="Loading open pull requests"]')).toBeHidden();
  const tabs = screen.getByRole("navigation", "Workspace tabs");
  const close = tabs.getByRole("button", /Close/);
  while ((await close.count()) > 0) await close.first().tap();
  await tabs.getByRole("link", "Inbox").tap();
  await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
  await expect(browser.locator("[data-app-sidebar]")).toHaveCount(0);
  await expect(tabs.getByRole("button", /Close/)).toHaveCount(0);
  // The line between Inbox and the PR tabs shows only once a PR is open.
  await expect(tabs.getByRole("separator")).toHaveCount(0);
  await expect(screen.getByText("No open pull requests")).toContainText("No open pull requests");
  await expect(browser).toHaveURL("/");
  const footer = screen.getByTestId("app-info");
  await expect(footer).toContainText(`prkit ${serverVersion()}`);
  await expect(footer).toContainText(run.home);
  await app.screenshot("zero-pr-tabs");
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+w`);
  await expect(tabs.getByRole("link", "Inbox")).toHaveAttribute("aria-current", "page");
  await browser.keyboard.press(`${modifier}+Comma`);
  await expect(screen.getByRole("heading", "Settings")).toBeVisible();
  await expect(browser).toHaveURL("/settings/accounts");
  // Settings is a tab after the Inbox, with the line between them, and no header row of its own.
  await expect(tabs.getByRole("link", "Settings")).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("separator")).toHaveCount(1);
  await expect(screen.getByRole("button", "Back")).toHaveCount(0);
  await app.screenshot("settings-tab");
  await browser.keyboard.press(`${modifier}+w`);
  await expect(browser).toHaveURL("/");
  await expect(tabs.getByRole("link", "Settings")).toHaveCount(0);
  await expect(tabs.getByRole("separator")).toHaveCount(0);
  await browser.keyboard.press(`${modifier}+k`);
  const dialog = screen.getByRole("dialog", "Find a pull request");
  await dialog.getByRole("searchbox", "Find a pull request").fill("settings");
  await dialog.getByRole("button", "Settings").tap();
  await expect(tabs.getByRole("link", "Settings")).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", "Close Settings").tap();
  await expect(browser).toHaveURL("/");
  for (const shortcut of [`${modifier}+t`, `${modifier}+k`, `${modifier}+n`]) {
    await browser.keyboard.press(shortcut);
    await expect(dialog.getByRole("searchbox", "Find a pull request")).toBeFocused();
    await browser.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  // Cmd+N does what "+" does: the palette opens to find a PR, without Settings.
  await browser.keyboard.press(`${modifier}+n`);
  await expect(dialog.getByRole("searchbox", "Find a pull request")).toBeFocused();
  await expect(dialog.getByRole("button", "Settings")).toHaveCount(0);
  await app.screenshot("palette-from-cmd-n");
  await browser.keyboard.press("Escape");
  await screen.getByRole("button", "Open a pull request").tap();
  await expect(dialog.getByRole("button", "Settings")).toHaveCount(0);
  await browser.keyboard.press("Escape");
  const key = modifier === "Meta" ? "⌘" : "Ctrl+";
  await browser.locator('button[aria-label="Open a pull request"]').hover();
  await expect(browser.locator('[data-slot="tooltip-popup"]')).toContainText(`${key}N`);
  await app.screenshot("open-pr-shortcut-tooltip");
  await tabs.getByRole("link", "Inbox").hover();
  await expect(browser.locator('[data-slot="tooltip-popup"]')).toContainText(`Inbox ${key}1`);
  await expect(footer).toContainText(run.home);
});

/** Where the title bar's mark and rose wash sit, and how the wash is painted. */
const titleBar = (browser: Browser) =>
  browser.evaluate(() => {
    const header = document.querySelector("[data-workspace-tabbar]");
    const backdrop = header?.querySelector("[data-titlebar-backdrop]");
    const box = (node: Element | null | undefined) => {
      const rect = node?.getBoundingClientRect();
      return rect === undefined
        ? null
        : [rect.left, rect.top, rect.right, rect.bottom].map((edge) => Math.round(edge));
    };
    return {
      header: box(header),
      backdrop: box(backdrop),
      mark: box(header?.querySelector('svg[aria-label="prkit"]')),
      colors: [...(backdrop?.querySelectorAll("radialGradient stop:first-child") ?? [])].map(
        (stop) => getComputedStyle(stop).stopColor,
      ),
      strengths: [...(backdrop?.querySelectorAll("rect") ?? [])].map(
        (rect) => getComputedStyle(rect).fillOpacity,
      ),
      animations: backdrop?.getAnimations({ subtree: true }).length ?? null,
    };
  });

test("the title bar carries the prkit mark over a still rose wash, tuned for light and dark", async ({
  app,
  screen,
  browser,
}) => {
  // An instance of its own: journeys before this one leave the shared instance's theme set.
  const fake = await startFakeGitHub("title-bar");
  try {
    const run = startFakeInstance("title-bar", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
    // Decoration: hidden from assistive tech, which reads the window title instead.
    await expect(browser.locator('[data-workspace-tabbar] svg[aria-label="prkit"]')).toBeVisible();
    // The wash fills the corner behind the mark, the bar's full height, above the panel.
    const placed = { backdrop: [0, 0, 360, 52], mark: [16, 18, 77, 34], animations: 0 };
    expect(await titleBar(browser)).toMatchObject({
      ...placed,
      colors: ["rgb(255, 231, 236)", "rgb(250, 159, 180)"],
      strengths: ["0.85", "0.2"],
    });
    await setOsColorScheme(browser, "dark");
    await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: true });
    expect(await titleBar(browser)).toMatchObject({
      ...placed,
      colors: ["rgb(172, 40, 86)", "rgb(224, 68, 110)"],
      strengths: ["0.3", "0.1"],
    });
    await setOsColorScheme(browser, "light");
    await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false });
    await screenshotLightAndDark(app, browser, "title-bar");
  } finally {
    stopFakeInstance("title-bar", { keepHome: false });
    fake.stop();
  }
});

test("the boot splash lays out the frame and the panel the app opens on, in light and dark", async ({
  app,
  screen,
  browser,
}) => {
  // An instance of its own, so the stored theme is System and the emulated OS picks the splash's.
  const fake = await startFakeGitHub("boot-splash");
  try {
    const run = startFakeInstance("boot-splash", fake);
    await emulateOsColorScheme(browser, "light");
    // A page on the instance's origin, so the emulated OS can be switched before each splash.
    await app.open(run.openUrl);
    for (const scheme of ["light", "dark"] as const) {
      const paint = PAINT[scheme];
      const opensOn = {
        frame: paint.frame,
        panel: [6, 52, 6, 6],
        panelRadius: "10px",
        panelSurface: paint.panel,
        panelShadows: [...paint.edge, paint.lift],
      };
      // Without the app's entry script the page stays on what index.html paints before React,
      // which reads the OS appearance once, as it loads.
      await setOsColorScheme(browser, scheme);
      await browser.route("**/assets/index-*.js", (route) => route.abort());
      await app.open(run.openUrl);
      await expect(screen.getByRole("img", "prkit")).toBeVisible();
      const splash = await insetFrame(browser, { frame: "#boot-shell", panel: "#boot-panel" });
      expect(splash).toMatchObject(opensOn);
      expect(splash.grain).toMatch(/^url\("data:image\/svg\+xml,/);
      expect(await splashWash(browser)).toEqual({ box: [0, 0, 360, 52], layers: paint.washLayers });
      await app.screenshot(`boot-splash-inset-${scheme}`);

      await browser.unroute("**/assets/index-*.js");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible();
      expect(await insetFrame(browser)).toMatchObject({ ...opensOn, grain: splash.grain });
    }
  } finally {
    stopFakeInstance("boot-splash", { keepHome: false });
    fake.stop();
  }
});

/**
 * The window's frame, the workspace panel inset from it, and how each title bar tab is painted.
 * `at` points it at the boot splash's frame and panel instead of the app's.
 */
const insetFrame = (browser: Browser, at = { frame: "body", panel: "[data-workspace-panel]" }) =>
  browser.evaluate((at: { frame: string; panel: string }) => {
    // Left and top from the window's top-left corner, right and bottom from its bottom-right.
    const insets = (node: Element | null) => {
      const rect = node?.getBoundingClientRect();
      return rect === undefined
        ? null
        : [rect.left, rect.top, innerWidth - rect.right, innerHeight - rect.bottom].map((edge) =>
            Math.round(edge),
          );
    };
    // Tailwind's empty ring and shadow layers paint nothing; keep the layers that do.
    const shadows = (style: CSSStyleDeclaration) =>
      style.boxShadow
        .split(/,(?![^(]*\))/)
        .map((layer) => layer.trim())
        .filter((layer) => layer !== "none" && !layer.startsWith("rgba(0, 0, 0, 0)"));
    const frame = document.querySelector(at.frame);
    const panel = document.querySelector(at.panel);
    const panelStyle = panel === null ? null : getComputedStyle(panel);
    const bar = document.querySelector("[data-workspace-tabbar]");
    const wash = document.querySelector("[data-titlebar-backdrop]")?.getBoundingClientRect();
    return {
      frame: frame === null ? null : getComputedStyle(frame).backgroundColor,
      grain: frame === null ? null : getComputedStyle(frame).backgroundImage,
      barHeight: bar?.getBoundingClientRect().height ?? null,
      barBorder: bar === null ? null : getComputedStyle(bar).borderBottomWidth,
      wash: wash === undefined ? null : [wash.left, wash.top, wash.right, wash.bottom],
      panel: insets(panel),
      panelRadius: panelStyle?.borderRadius ?? null,
      panelClips: panelStyle?.overflow ?? null,
      panelSurface: panelStyle?.backgroundColor ?? null,
      panelShadows: panelStyle === null ? null : shadows(panelStyle),
      tabs: [...document.querySelectorAll("[data-workspace-tabbar] [data-active-tab]")].map(
        (tab) => {
          const style = getComputedStyle(tab);
          return {
            name: (tab.querySelector("[data-open-pr]") ?? tab).textContent?.trim() ?? null,
            active: tab.getAttribute("data-active-tab") === "true",
            surface: style.backgroundColor,
            shadows: shadows(style),
          };
        },
      ),
    };
  }, at);

/** The splash's title bar wash: its box, and each gradient layer's shape and first color, top first. */
const splashWash = (browser: Browser) =>
  browser.evaluate(() => {
    const shell = document.querySelector("#boot-shell");
    if (shell === null) return null;
    const style = getComputedStyle(shell, "::before");
    const left = parseFloat(style.left);
    const top = parseFloat(style.top);
    return {
      box: [left, top, left + parseFloat(style.width), top + parseFloat(style.height)],
      layers: [
        ...style.backgroundImage.matchAll(/radial-gradient\(([^,]+), (rgba?\([^)]*\))/g),
      ].map((layer) => [layer[1] ?? "", layer[2] ?? ""]),
    };
  });

/** Whether an overlay renders outside the panel, where the panel cannot clip it, and on top. */
const abovePanel = (browser: Browser, selector: string) =>
  browser.evaluate((selector: string) => {
    const node = document.querySelector(selector);
    const rect = node?.getBoundingClientRect();
    if (node === null || rect === undefined) return null;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      insidePanel: node.closest("[data-workspace-panel]") !== null,
      onTop: hit !== null && node.contains(hit),
    };
  }, selector);

/** How far a toast sits from the window's right and bottom edges. */
const toastCorner = (browser: Browser) =>
  browser.evaluate(() => {
    const rect = document
      .querySelector('[role="region"] :is([role="dialog"], [role="alertdialog"])')
      ?.getBoundingClientRect();
    return rect === undefined
      ? null
      : [Math.round(innerWidth - rect.right), Math.round(innerHeight - rect.bottom)];
  });

const PAINT = {
  light: {
    frame: "rgb(242, 238, 233)",
    panel: "rgb(252, 250, 247)",
    edge: ["rgba(25, 21, 17, 0.1) 0px 0px 0px 1px", "rgb(255, 255, 255) 0px 1px 0px 0px inset"],
    lift: "rgba(25, 21, 17, 0.06) 0px 1px 2px 0px",
    hover: "rgba(25, 21, 17, 0.05)",
    // TitleBarBackdrop's layers as the splash draws them, top first: its core, then its wash.
    washLayers: [
      ["130px 40px at 30px 4px", "rgba(250, 159, 180, 0.2)"],
      ["320px 58px at 36px 6px", "rgba(255, 231, 236, 0.85)"],
    ],
  },
  dark: {
    frame: "rgb(21, 17, 13)",
    panel: "rgb(25, 21, 17)",
    edge: [
      "rgba(255, 255, 255, 0.1) 0px 0px 0px 1px",
      "rgba(255, 255, 255, 0.08) 0px 1px 0px 0px inset",
    ],
    lift: "rgba(0, 0, 0, 0.4) 0px 1px 3px 0px",
    hover: "rgba(252, 250, 247, 0.05)",
    washLayers: [
      ["130px 40px at 30px 4px", "rgba(224, 68, 110, 0.1)"],
      ["320px 58px at 36px 6px", "rgba(172, 40, 86, 0.3)"],
    ],
  },
};
const PLAIN = { surface: "rgba(0, 0, 0, 0)", shadows: [] };

test("the workspace sits on a panel inset from the window's frame, and the active tab is cut from it", async ({
  app,
  screen,
  browser,
}) => {
  // An instance of its own, so the theme and the open tabs are this journey's.
  const fake = await startFakeGitHub("inset-frame");
  try {
    const run = startFakeInstance("inset-frame", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    const tabs = screen.getByRole("navigation", "Workspace tabs");
    const prTab = browser.locator('a[data-open-pr="github.com/budget/fixtures#1"]');
    await tabs.getByRole("link", "Inbox").tap();
    await screen.getByRole("link", /#1 Budget fixture 1/).tap({ timeout: 20_000 });
    await expect(screen.getByRole("heading", "Budget fixture 1")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await setOsColorScheme(browser, scheme);
      await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: scheme === "dark" });
      const paint = PAINT[scheme];
      // The bar has no border of its own: the panel's ring and highlight end it. The wash stays
      // on the frame above the panel, and the panel is inset 6px on three sides, flush under the bar.
      expect(await insetFrame(browser)).toMatchObject({
        frame: paint.frame,
        barHeight: 52,
        barBorder: "0px",
        wash: [0, 0, 360, 52],
        panel: [6, 52, 6, 6],
        panelRadius: "10px",
        panelClips: "clip",
        panelSurface: paint.panel,
        panelShadows: [...paint.edge, paint.lift],
        tabs: [
          { name: "Inbox", active: false, ...PLAIN },
          { name: "#1", active: true, surface: paint.panel, shadows: paint.edge },
        ],
      });
      // An inactive tab answers the pointer on the frame's own palette.
      await tabs.getByRole("link", "Inbox").hover();
      await expect
        .poll(() => insetFrame(browser))
        .toMatchObject({ tabs: [{ name: "Inbox", surface: paint.hover }, { name: "#1" }] });
      await app.screenshot(`inset-frame-pr-${scheme}`);
      await browser.mouse.move(640, 400);

      // A toast keeps the 16px from the panel's corner that it kept from the window's.
      await screen.getByRole("button", "Copy gh pr checkout 1").tap();
      await expect.poll(() => toastCorner(browser)).toEqual([6 + 16, 6 + 16]);
      await app.screenshot(`inset-frame-toast-${scheme}`);
      await expect.poll(() => toastCorner(browser), { timeout: 15_000 }).toBeNull();

      await tabs.getByRole("link", "Inbox").tap();
      await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
      expect(await insetFrame(browser)).toMatchObject({
        tabs: [
          { name: "Inbox", active: true, surface: paint.panel, shadows: paint.edge },
          { name: "#1", active: false, ...PLAIN },
        ],
      });
      await app.screenshot(`inset-frame-inbox-${scheme}`);

      // Overlays render above the panel, never clipped by it. A tooltip lets the pointer
      // through, so only where it renders is checked.
      await screen.getByRole("button", "Open a pull request").hover();
      await expect(browser.locator('[data-slot="tooltip-popup"]')).toBeVisible();
      expect(await abovePanel(browser, '[data-slot="tooltip-popup"]')).toMatchObject({
        insidePanel: false,
      });
      await screen.getByRole("button", "Open a pull request").tap();
      await expect(screen.getByRole("searchbox", "Find a pull request")).toBeFocused();
      expect(await abovePanel(browser, '[role="dialog"]')).toEqual({
        insidePanel: false,
        onTop: true,
      });
      await app.screenshot(`inset-frame-palette-${scheme}`);
      await browser.keyboard.press("Escape");
      await prTab.tap();
      await expect(screen.getByRole("heading", "Budget fixture 1")).toBeVisible();
    }
  } finally {
    stopFakeInstance("inset-frame", { keepHome: false });
    fake.stop();
  }
});
