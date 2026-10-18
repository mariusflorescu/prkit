import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";

const PR = (number: number) => `github.com/budget/fixtures#${number}`;
const decodeTabs = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      active: Schema.NullOr(Schema.String),
      open: Schema.Array(Schema.Struct({ key: Schema.String })),
    }),
  ),
);

/** The tabs in the strip, in order, and the one it shows as selected. */
const strip = ({ browser }: { readonly browser: Browser }) =>
  browser.evaluate(() => ({
    keys: [...document.querySelectorAll("[data-open-pr]")].map(
      (tab) => tab.getAttribute("data-open-pr") ?? "",
    ),
    selected:
      document
        .querySelector('[data-active-tab="true"] [data-open-pr]')
        ?.getAttribute("data-open-pr") ?? null,
  }));

/** The page shows the fake GitHub's PR #1, and the strip agrees: #1 is its selected tab. */
const showsFirst = async ({
  screen,
  browser,
}: Pick<TestFixtures, "screen"> & { browser: Browser }) => {
  await expect(screen.getByRole("heading", /Budget fixture 1/)).toBeVisible({ timeout: 30_000 });
  await expect(browser.locator('[data-active-tab="true"] [data-open-pr]')).toHaveAttribute(
    "data-open-pr",
    PR(1),
  );
};

test(
  "a pull request opened in the background leaves the selected tab and the page alone, across a relaunch",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const name = "workspace-background-open";
    const fake = await startFakeGitHub(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    try {
      const run = startFakeInstance(name, fake);
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      await browser.setViewport({ width: 1280, height: 720 });
      await switchOn({ app, screen, browser }, run.openUrl);

      expect(cli(root, ["pr", "open", "budget/fixtures#1", "--json"]).code).toBe(0);
      await showsFirst({ screen, browser });

      const opened = cli(root, ["pr", "open", "budget/fixtures#2", "--no-focus", "--json"]);
      expect(opened.code).toBe(0);
      expect(decodeTabs(opened.stdout).active).toBe(PR(1));
      const tabs = screen.getByRole("navigation", "Workspace tabs");
      await expect(tabs.getByRole("link", /^Open budget\/fixtures #2\b/)).toBeVisible({
        timeout: 15_000,
      });
      await showsFirst({ screen, browser });
      expect(await strip({ browser })).toEqual({ keys: [PR(1), PR(2)], selected: PR(1) });
      expect(decodeTabs(cli(root, ["tabs", "list", "--json"]).stdout).active).toBe(PR(1));
      await dismissToasts(browser);
      await app.screenshot("background-open");

      stopFakeInstance(name, { keepHome: true });
      const again = startFakeInstance(name, fake);
      await app.open(again.openUrl);
      await showsFirst({ screen, browser });
      expect(await strip({ browser })).toEqual({ keys: [PR(1), PR(2)], selected: PR(1) });
      await app.screenshot("background-open-relaunched");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
      const evidence = NodePath.join(import.meta.dirname, "../.e2e/evidence", name);
      NodeFS.mkdirSync(evidence, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(evidence, "cli-transcript.txt"), log.join("\n\n"));
    }
  },
);
