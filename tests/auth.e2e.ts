import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("opening the app without a session token explains how to get back in", async ({
  app,
  screen,
  browser,
}) => {
  await app.open("/");

  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  const alert = browser.locator('footer[role="alert"]');
  await expect(alert).toContainText(
    "This window has no session token. Reopen prkit from the desktop app or from the URL the dev runner printed.",
  );
  await expect(alert.getByRole("button", "Retry")).toBeVisible();
  await app.screenshot("missing-token");
});
