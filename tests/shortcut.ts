import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

/**
 * Presses one of prkit's shortcuts with the platform's modifier: Cmd on macOS, Ctrl elsewhere.
 * `app.open` and `browser.reload` can return while the boot splash still shows, and the
 * shortcuts listen only once the app has drawn its tab strip, so a key pressed sooner does
 * nothing.
 */
export const pressShortcut = async (screen: Screen, browser: Browser, key: string) => {
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+${key}`);
};
