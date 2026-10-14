import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";

// Updates belong to the desktop app. In a plain browser there is nothing to update, so no
// update UI may show: no title bar button, no Settings section, no page at its address.
// The desktop flow itself is proved on packaged builds (desktop-updates in
// .agents/skills/verify-prkit/features/desktop-updates.md).
test("the web build shows no update UI", async ({ app, screen, browser }) => {
  const fake = await startFakeGitHub("updates-web");
  try {
    const run = startFakeInstance("updates-web", fake);
    await app.open(run.openUrl);
    const tabs = screen.getByRole("navigation", "Workspace tabs");
    await expect(tabs.getByRole("link", "Inbox")).toBeVisible();
    expect(await browser.evaluate(() => "prkitDesktop" in window)).toBe(false);
    await expect(
      screen.getByRole("button", /^(Update to|Downloading|Restart to update)/),
    ).toHaveCount(0);

    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+Comma`);
    const sections = screen.getByRole("navigation", "Settings sections");
    await expect(sections.getByRole("link", "About")).toBeVisible();
    await expect(sections.getByRole("link", "Updates")).toHaveCount(0);

    await browser.evaluate(() => {
      history.pushState(null, "", "/settings/updates");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(screen.getByRole("heading", "Updates")).toHaveCount(0);
  } finally {
    stopFakeInstance("updates-web", { keepHome: false });
    fake.stop();
  }
});
