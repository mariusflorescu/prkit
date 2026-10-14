import { expect, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { choose } from "./pickers.ts";

/**
 * Journeys in a run share one instance, and the app restores whichever tab was active last
 * and the Inbox's last filters, so a journey that needs the Inbox must select it and clear
 * them rather than assume either.
 */
export const openInbox = async ({ app, screen }: Pick<TestFixtures, "app" | "screen">) => {
  await app.open(runForUrl(app.baseUrl).openUrl);
  const inbox = screen.getByRole("link", "Inbox");
  await inbox.tap();
  await expect(inbox).toHaveAttribute("aria-current", "page");
  // The saved filters arrive with the open tabs, and the account filter with the accounts.
  await expect(screen.getByLabel("Loading open pull requests")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(screen.getByLabel("Loading pull requests")).toHaveCount(0, { timeout: 45_000 });
  await screen.getByRole("searchbox", "Search pull requests").fill("");
  const account = screen.getByRole("combobox", "Filter by GitHub account");
  if ((await account.count()) > 0 && (await account.textContent())?.trim() !== "All accounts")
    await choose(screen, account, "All accounts");
  const repository = screen.getByRole("button", /^Filter by repository: /);
  if ((await repository.getAttribute("aria-label")) !== "Filter by repository: All repositories")
    await choose(screen, repository, "All repositories");
};
