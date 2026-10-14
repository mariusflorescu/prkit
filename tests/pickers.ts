import type { Browser } from "@e2e-dev/web";
import { expect, type Locator, type Screen } from "e2e";

/** Opens a select (or a filter) and picks one of its options by name. */
export const choose = async (screen: Screen, trigger: Locator, option: string | RegExp) => {
  await trigger.tap();
  await screen.getByRole("option", option).tap();
};

/**
 * How many GitHub accounts the app found, counted in Settings > Accounts. Closing the Settings
 * tab (Cmd+W) returns to the page it came from.
 */
export const accountCount = async (screen: Screen, browser: Browser) => {
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "Accounts").tap();
  const statuses = screen.getByRole("main").getByText(/^(Ready|Needs attention)$/);
  await expect(statuses.first()).toBeVisible({ timeout: 30_000 });
  const count = await statuses.count();
  await browser.keyboard.press(`${modifier}+w`);
  return count;
};

/**
 * Picks, in the Inbox's account filter, the first account other than `login`. Undefined when
 * the machine has only that one, whose Inbox shows no account filter.
 */
export const chooseOtherAccount = async (screen: Screen, browser: Browser, login: string) => {
  if ((await accountCount(screen, browser)) < 2) return undefined;
  await screen.getByRole("combobox", "Filter by GitHub account").tap();
  await expect(screen.getByRole("option", "All accounts")).toBeVisible();
  const label = (await screen.getByRole("option").allTextContents()).find(
    (text) => text !== "All accounts" && text !== login,
  );
  await screen.getByRole("option", label ?? "All accounts").tap();
  if (label === undefined) return undefined;
  const [name = label, host = "github.com"] = label.split(" · ");
  return { login: name, id: `${host}/${name}` };
};

/** Settings > Guides: finds a repository by its owner/name in the picker and picks it. */
export const pickGuideRepository = async (screen: Screen, name: string) => {
  await screen.getByRole("button", /^Repository/).tap({ timeout: 30_000 });
  await screen.getByRole("combobox", "Search repositories").fill(name);
  await screen.getByRole("option", name).tap({ timeout: 30_000 });
};

/** The merge form's names for each method, as the Method select shows them. */
export const METHOD_LABELS = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
} as const;
