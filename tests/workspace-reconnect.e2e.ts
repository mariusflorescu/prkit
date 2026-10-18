import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { cliIn, scratchRoot, switchOn } from "./localGuideSession.ts";
import { localRepoFixture } from "./localRepoFixture.ts";

declare global {
  interface Window {
    workspaceOffline: { away: () => void; back: () => void; connected: () => boolean };
    workspaceStrips: Array<{ keys: Array<string>; skeleton: boolean }>;
  }
}

const decodeTabs = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ active: Schema.NullOr(Schema.String) })),
);
const PR = (number: number) => `github.com/budget/fixtures#${number}`;
const target = (number: number) => `budget/fixtures#${number}`;

/**
 * Wraps the page's WebSocket so the journey can take the window offline: `away` closes every
 * open socket and makes new ones fail the way they do with no network, `back` lets them through.
 */
const offlineSwitch = () => {
  const Native = window.WebSocket;
  const open = new Set<WebSocket>();
  let away = false;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | Array<string>) {
      super(away ? "ws://127.0.0.1:9/" : url, protocols);
      open.add(this);
      this.addEventListener("close", () => open.delete(this));
    }
  };
  window.workspaceOffline = {
    away: () => {
      away = true;
      for (const socket of open) socket.close(4000, "offline");
    },
    back: () => {
      away = false;
    },
    connected: () => [...open].some((socket) => socket.readyState === WebSocket.OPEN),
  };
};

/** Records the tab strip each time it changes: the tabs' keys in order, and whether its skeleton shows. */
const watchStrip = () => {
  const strips: Window["workspaceStrips"] = [];
  window.workspaceStrips = strips;
  const read = () => {
    const nav = document.querySelector('nav[aria-label="Workspace tabs"]');
    if (nav === null) return;
    const keys = [...nav.querySelectorAll("[data-open-pr], [data-local-tab]")].map(
      (tab) => tab.getAttribute("data-open-pr") ?? `local ${tab.getAttribute("data-local-tab")}`,
    );
    const skeleton = nav.querySelector('[aria-label="Loading open pull requests"]') !== null;
    const last = strips.at(-1);
    if (last === undefined || last.skeleton !== skeleton || last.keys.join() !== keys.join())
      strips.push({ keys, skeleton });
  };
  read();
  new MutationObserver(read).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
  });
  return null;
};

/** Brings the window back online and waits until its socket is open again. */
const reconnect = async (browser: Browser) => {
  await browser.evaluate(() => {
    window.workspaceOffline.back();
    return null;
  });
  const deadline = Date.now() + 30_000;
  while (!(await browser.evaluate(() => window.workspaceOffline.connected()))) {
    if (Date.now() > deadline) throw new Error("The window didn't reconnect in 30 s.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

test(
  "tabs an outside agent opens while the window is offline show up once it reconnects",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const name = "workspace-reconnect";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    try {
      const fixture = localRepoFixture(root);
      const run = startFakeInstance(name, fake, ["--claude", claude.file]);
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      await browser.addInitScript(offlineSwitch);
      await browser.setViewport({ width: 1280, height: 720 });
      await switchOn({ app, screen, browser }, run.openUrl);
      const tabs = screen.getByRole("navigation", "Workspace tabs");

      expect(cli(root, ["pr", "open", target(1), "--json"]).code).toBe(0);
      expect(cli(root, ["pr", "open", target(2), "--no-focus", "--json"]).code).toBe(0);
      await expect(tabs.getByRole("link", /^Open budget\/fixtures #2\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(screen.getByRole("heading", /Budget fixture 1/)).toBeVisible();
      const page = await browser.url();
      await browser.evaluate(watchStrip);

      await browser.evaluate(() => {
        window.workspaceOffline.away();
        return null;
      });
      expect(cli(root, ["pr", "open", target(3), "--no-focus", "--json"]).code).toBe(0);
      expect(cli(fixture.repo, ["local", "guide", "--json"]).code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const missed = await tabs.getByRole("link", /^Open budget\/fixtures #3\b/).count();
      expect(missed, "the offline window can't hear the new tabs").toBe(0);

      await reconnect(browser);
      await expect(tabs.getByRole("link", /^Open budget\/fixtures #3\b/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(tabs.getByRole("link", /^Open the local review of widgets/)).toBeVisible({
        timeout: 15_000,
      });
      expect(await browser.url()).toBe(page);
      await expect(screen.getByRole("heading", /Budget fixture 1/)).toBeVisible();
      await expect(browser.locator('[data-active-tab="true"] [data-open-pr]')).toHaveAttribute(
        "data-open-pr",
        PR(1),
      );
      const deadline = Date.now() + 15_000;
      while (decodeTabs(cli(root, ["tabs", "list", "--json"]).stdout).active !== PR(1)) {
        if (Date.now() > deadline) throw new Error("The server's active PR isn't the one shown.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await app.screenshot("reconnected-tabs");

      await browser.evaluate(() => {
        window.workspaceOffline.away();
        return null;
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await reconnect(browser);
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const strips = await browser.evaluate(() => window.workspaceStrips);
      log.push(JSON.stringify(strips, null, 2));
      const last = strips.at(-1);
      expect(last?.keys.slice(0, 3)).toEqual([PR(1), PR(2), PR(3)]);
      expect(last?.keys).toHaveLength(4);
      expect(last?.keys[3]).toMatch(/^local local:[0-9a-f]{16}$/);
      for (const strip of strips) {
        expect(strip.skeleton, "the strip never falls back to its skeleton").toBe(false);
        expect(strip.keys.slice(0, 2), "the user's tabs keep their place").toEqual([PR(1), PR(2)]);
        expect(new Set(strip.keys).size, "no tab shows twice").toBe(strip.keys.length);
      }
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
      const evidence = NodePath.join(import.meta.dirname, "../.e2e/evidence", name);
      NodeFS.mkdirSync(evidence, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(evidence, "transcript.txt"), log.join("\n\n"));
    }
  },
);
