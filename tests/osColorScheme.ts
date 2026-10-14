import type { Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

/**
 * Stands in for the OS appearance inside the page, so a journey can have a light or dark
 * system without changing the machine's own setting. It replaces
 * `matchMedia("(prefers-color-scheme: dark)")` before any page script runs, on every load,
 * and keeps its value in sessionStorage so a reload keeps the "OS" the test chose.
 * Call it before `app.open`.
 */
export const emulateOsColorScheme = (browser: Browser, initial: "light" | "dark") =>
  browser.addInitScript(
    `(() => {
      const query = "(prefers-color-scheme: dark)";
      const real = window.matchMedia.bind(window);
      const listeners = new Set();
      if (sessionStorage.getItem("os-dark") === null)
        sessionStorage.setItem("os-dark", ${JSON.stringify(initial === "dark")});
      const isDark = () => sessionStorage.getItem("os-dark") === "true";
      window.matchMedia = (asked) =>
        asked !== query
          ? real(asked)
          : {
              media: query,
              onchange: null,
              get matches() { return isDark(); },
              addEventListener: (_type, listener) => listeners.add(listener),
              removeEventListener: (_type, listener) => listeners.delete(listener),
              addListener: (listener) => listeners.add(listener),
              removeListener: (listener) => listeners.delete(listener),
              dispatchEvent: () => false,
            };
      window.setOsColorScheme = (scheme) => {
        sessionStorage.setItem("os-dark", String(scheme === "dark"));
        listeners.forEach((listener) => listener({ matches: isDark(), media: query }));
      };
    })()`,
  );

/** The OS changes appearance while the page is open. */
export const setOsColorScheme = (browser: Browser, scheme: "light" | "dark") =>
  browser.evaluate(
    (next: "light" | "dark") => Reflect.get(window, "setOsColorScheme")(next),
    scheme,
  );

/** What the page painted: the `dark` class on <html> and the stored choice it carries. */
export const readPageTheme = (browser: Browser) =>
  browser.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    choice: document.documentElement.dataset.theme ?? null,
    background: getComputedStyle(document.documentElement).backgroundColor,
  }));

/**
 * Saves `<name>-light` and `<name>-dark` of the same screen, switching the emulated OS
 * appearance (see emulateOsColorScheme) while the theme is System, and ends in light.
 */
export const screenshotLightAndDark = async (
  app: TestFixtures["app"],
  browser: Browser,
  name: string,
) => {
  await app.screenshot(`${name}-light`);
  await setOsColorScheme(browser, "dark");
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: true });
  await app.screenshot(`${name}-dark`);
  await setOsColorScheme(browser, "light");
  await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false });
};
