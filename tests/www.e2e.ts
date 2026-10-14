import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { type Browser, test, type WebRoute } from "@e2e-dev/web";
import { expect } from "e2e";

const dist = NodePath.resolve(import.meta.dirname, "../apps/www/dist");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The built site (`pnpm build:www`), served the way a static host would serve it. */
const siteTest = test.extend<{ site: string }>({
  site: async ({ browser }, use) => {
    // The page asks GitHub for the latest release when the build names a repository. No journey
    // reaches the real API: unless a journey answers itself, there is no release yet.
    await browser.route("https://api.github.com/**", (route) =>
      route.fulfill({ status: 404, json: { message: "Not Found" } }),
    );
    if (!NodeFS.existsSync(NodePath.join(dist, "index.html"))) {
      throw new Error("apps/www/dist is missing. Run pnpm build:www first.");
    }
    const server = NodeHttp.createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://site").pathname);
      const file = NodePath.join(dist, path.endsWith("/") ? `${path}index.html` : path);
      if (!file.startsWith(dist) || !NodeFS.existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": types[NodePath.extname(file)] ?? "application/octet-stream",
      });
      NodeFS.createReadStream(file).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await use(`http://127.0.0.1:${port}/`);
    // The page stays open until after this teardown, and `close` alone waits for every socket
    // it holds: a load still in flight, keep-alive, or one Chrome opened and never used.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  },
});

siteTest(
  "the website explains prkit on one page, with every asset served by the site itself",
  async ({ app, screen, browser, site }) => {
    const requests: Array<string> = [];
    await browser.route("**/*", async (route) => {
      requests.push(route.request.url);
      // The release lookup is not an asset; the fixture answers it.
      if (route.request.url.startsWith("https://api.github.com/")) await route.fallback();
      else await route.continue();
    });
    await app.open(site);

    await expect(
      screen.getByRole("heading", "Your agents write the code. prkit keeps you in the loop."),
    ).toBeVisible();
    await expect(screen.getByText("Coming soon")).toBeVisible();
    await expect(screen.getByRole("link", "Follow along on GitHub")).toBeVisible();
    await app.screenshot("www-hero");

    // Scrolling past every section is what loads the lazy screenshot, as it does for a reader.
    for (const name of [
      "What it does",
      "Sorted by why it needs you",
      "Review comments, fixed on a copy",
      "One guide per layer",
      "The real thing",
      "How it works",
      "Local first. Your code and your keys stay on your Mac.",
      "prkit is one app on your Mac, with your accounts and your agent. Nothing else.",
      "Questions people ask first",
      "Coming soon to your Mac.",
    ]) {
      const heading = screen.getByRole("heading", name);
      await heading.scrollIntoView();
      await expect(heading).toBeVisible();
    }
    await expect(screen.getByText("Is it open source?")).toBeVisible();

    const page = await browser.evaluate(async () => {
      await Promise.all([...document.images].map((image) => image.decode()));
      return {
        images: [...document.images].map((image) => ({
          alt: image.alt,
          loaded: image.complete && image.naturalWidth > 0,
        })),
        // A slot holds its frame whether the drawing has landed or not.
        figures: document.querySelectorAll("[data-figure]").length,
        // Figures carry no numbers and no live readout.
        numbered: document.querySelectorAll('[data-figure] [data-corner="fig"]').length,
        readouts: document.querySelectorAll("[data-readout]").length,
        captions: [...document.querySelectorAll("[data-figure] .prk-figure-caption")]
          .map((caption) => caption.textContent?.trim() ?? "")
          .filter((text) => /^Fig(ure)?\s*\d/.test(text)),
        font: getComputedStyle(document.body).fontFamily,
        // Astro names each family `<name>-<hash>` and adds metric-matched fallback faces.
        faces: [...document.fonts]
          .filter((face) => face.status === "loaded" && !face.family.includes("fallback"))
          .map((face) => `${face.family.replaceAll('"', "").replace(/-\w+$/, "")} ${face.weight}`),
      };
    });
    expect(page.images.length).toBe(1);
    expect(page.figures).toBe(5);
    expect(page.numbered).toBe(0);
    expect(page.readouts).toBe(0);
    expect(page.captions).toEqual([]);
    expect(page.images.filter((image) => !image.loaded || image.alt.length === 0)).toEqual([]);
    expect(page.font).toMatch(/^"?Fira Sans"?/);
    for (const face of ["Fira Sans 400", "Fira Sans 500", "JetBrains Mono 400"]) {
      expect(page.faces).toContain(face);
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.filter((url) => !url.startsWith(site) && !url.startsWith("https://api.github.com/")),
    ).toEqual([]);
  },
);

siteTest("the hero intro plays once per session", async ({ app, browser, site }) => {
  await app.open(site);
  expect(await browser.evaluate(() => document.documentElement.dataset.intro ?? "first")).toBe(
    "first",
  );
  await browser.reload();
  expect(await browser.evaluate(() => document.documentElement.dataset.intro ?? "first")).toBe(
    "seen",
  );
});

siteTest(
  "the skip link shows above the sticky header when it has focus",
  async ({ app, browser, site }) => {
    await app.open(site);
    await browser.keyboard.press("Tab");
    const skip = await browser.evaluate(() => {
      const link = document.activeElement;
      if (!(link instanceof HTMLElement)) return null;
      const box = link.getBoundingClientRect();
      // Whatever paints at the link's center: the header, when it covers the link.
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: link.textContent, onTop: top !== null && link.contains(top) };
    });
    expect(skip).toEqual({ text: "Skip to content", onTop: true });
  },
);

/** Counts the animation frames the page asks for, so a journey can tell motion from stillness. */
const countFrames = `(() => {
  window.__frames = 0;
  const request = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    window.__frames += 1;
    return request(callback);
  };
})()`;
const framesSoFar = (browser: Browser) =>
  browser.evaluate(() => Number(Reflect.get(window, "__frames")));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Stands in for the system asking for less motion: live.js reads it through matchMedia. */
const lessMotion = `(() => {
  const query = "(prefers-reduced-motion: reduce)";
  const real = window.matchMedia.bind(window);
  window.matchMedia = (asked) =>
    asked !== query
      ? real(asked)
      : { media: query, matches: true, onchange: null, addEventListener() {}, removeEventListener() {},
          addListener() {}, removeListener() {}, dispatchEvent: () => false };
})()`;

/**
 * Jumps to the end of the page at once. The site scrolls smoothly, and a smooth scroll can still be
 * on its way, with the figure in its observer's margin, when a journey starts counting frames.
 */
const jumpToEnd = (browser: Browser) =>
  browser.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    return null;
  });

/** How many of the parts `selector` finds are on show: not hidden and not faded all the way out. */
const shownCount = (browser: Browser, selector: string) =>
  browser.evaluate(
    (query) =>
      [...document.querySelectorAll(query)].filter((node) => {
        const opacity = node.getAttribute("opacity");
        return (
          node.getAttribute("visibility") !== "hidden" && (opacity === null || Number(opacity) > 0)
        );
      }).length,
    selector,
  );
/** Whether the one part `selector` finds is fully on show. */
const fullyShown = (browser: Browser, selector: string) =>
  browser.evaluate((query) => {
    const node = document.querySelector(query);
    if (!node) return false;
    const opacity = node.getAttribute("opacity");
    return (
      node.getAttribute("visibility") !== "hidden" && (opacity === null || Number(opacity) >= 0.999)
    );
  }, selector);

/**
 * Sweeps a mouse across a figure's drawing, gliding in small steps over a grid of points and over
 * each of `hotspots` (the parts a pointer could once act on), then off the drawing. Returns every
 * change made to the figure meanwhile, as `<type> <attribute>` lines: nothing in a figure answers
 * to a pointer moving over it, not even for a moment.
 */
async function sweep(browser: Browser, slug: string, hotspots = "") {
  const points = await browser.evaluate(
    ({ name, spots }) => {
      const figure = document.querySelector(`[data-figure="${name}"]`);
      const stage = figure?.querySelector("[data-stage]");
      if (!figure || !stage) return [];
      stage.scrollIntoView({ block: "center", behavior: "instant" });
      const box = stage.getBoundingClientRect();
      const grid = [0.2, 0.4, 0.6, 0.8].flatMap((row) =>
        [0.05, 0.25, 0.5, 0.75, 0.95].map((column) => ({
          x: box.x + box.width * column,
          y: box.y + box.height * row,
        })),
      );
      const centres = spots
        ? [...figure.querySelectorAll(spots)].map((node) => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })
        : [];
      const middle = box.y + box.height / 2;
      return [
        { x: box.x - 20, y: middle },
        ...grid,
        ...centres,
        { x: box.x + box.width + 20, y: middle },
      ];
    },
    { name: slug, spots: hotspots },
  );
  expect(points.length).toBeGreaterThan(2);
  // Let the scroll settle before watching, so only the mouse can account for a change.
  await pause(300);
  await browser.evaluate((name) => {
    const changes: Array<string> = [];
    Reflect.set(window, "__changes", changes);
    const figure = document.querySelector(`[data-figure="${name}"]`);
    if (figure)
      new MutationObserver((records) => {
        for (const record of records) changes.push(`${record.type} ${record.attributeName ?? ""}`);
      }).observe(figure, { attributes: true, childList: true, characterData: true, subtree: true });
    return null;
  }, slug);
  const [start] = points;
  if (start) await browser.mouse.move(start.x, start.y);
  for (const [index, to] of points.entries()) {
    const from = points[index - 1];
    if (!from) continue;
    for (let step = 1; step <= 8; step++)
      await browser.mouse.move(
        from.x + ((to.x - from.x) * step) / 8,
        from.y + ((to.y - from.y) * step) / 8,
      );
  }
  await pause(500);
  return browser.evaluate(() => {
    const changes = Reflect.get(window, "__changes");
    return Array.isArray(changes) ? changes.map(String) : ["no observer"];
  });
}

siteTest(
  "a figure is drawn into the page, moves once near view, and stops when scrolled away",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/sample/`);

    await expect(browser.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
    await expect(screen.getByRole("img", /A dial indicator on a surface plate/)).toBeVisible();
    const figure = browser.locator('[data-figure="sample"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    // The frame names the figure without numbering it, and carries no readout.
    await expect(browser.locator('[data-corner="fig"]')).toHaveCount(0);
    await expect(browser.locator("[data-readout]")).toHaveCount(0);
    await expect(browser.locator(".prk-figure-caption")).toHaveText(/^A dial indicator/);
    await app.screenshot("www-figure-sample");

    // The idle tour runs while the figure is on screen.
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);

    // Scrolled away, it asks for no more frames.
    await screen.getByText(/The end of the page/).scrollIntoView();
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, it picks up again, and a button sends the carriage to a block.
    await figure.scrollIntoView();
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(away);
    const third = screen.getByRole("button", "Slide block 3, 10 tall, under the plunger");
    await third.click();
    await expect(third).toHaveAttribute("aria-pressed", "true");
  },
);

siteTest(
  "a figure stays still when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/sample/`);

    await expect(browser.locator('[data-figure="sample"]')).toHaveAttribute("data-live", "on");
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(0);
    const first = screen.getByRole("button", "Slide block 1, 18 tall, under the plunger");
    await expect(first).toHaveAttribute("aria-pressed", "true");

    // A mouse over the drawing changes nothing.
    expect(await sweep(browser, "sample")).toEqual([]);

    // A button still works, and the carriage snaps there without animating.
    const third = screen.getByRole("button", "Slide block 3, 10 tall, under the plunger");
    await third.click();
    await expect(third).toHaveAttribute("aria-pressed", "true");
    await expect(first).toHaveAttribute("aria-pressed", "false");
    expect(await framesSoFar(browser)).toBe(0);
  },
);

siteTest(
  "the hero figure tours a guide being written, stops when scrolled away, and jumps to a step",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/pr-guide/`);

    await expect(screen.getByRole("img", /A pull request window with its number/)).toBeVisible();
    const figure = browser.locator('[data-figure="pr-guide"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    await app.screenshot("www-figure-pr-guide");

    // The tour starts on its own from the still, on New commit, and comes round to Read.
    const read = screen.getByRole("button", "Read: show the agent reading the files");
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);
    await expect(read).toHaveAttribute("aria-pressed", "true", { timeout: 25_000 });

    // Scrolled away, it asks for no more frames.
    await jumpToEnd(browser);
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, a step button sends the tour there: a new commit lands on the graph.
    await figure.scrollIntoView();
    const commit = screen.getByRole("button", "New commit: show a new commit starting revision 2");
    await commit.click();
    await expect(commit).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => fullyShown(browser, '[data-part="graph-fresh"]')).toBe(true);

    // From there the tour is many seconds from Write, so only the click can press it this soon.
    const write = screen.getByRole("button", "Write: show the agent writing the guide");
    await write.click();
    await expect(write).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    // Every file has been read, and no chapter is checked yet.
    await expect.poll(() => fullyShown(browser, '[data-part="file-4-note"]')).toBe(true);
    await expect.poll(() => shownCount(browser, '[data-part$="-pass"]')).toBe(0);

    // The arrow keys move along the buttons and pick as they go.
    await write.press("ArrowLeft");
    await expect(read).toBeFocused();
    await expect(read).toHaveAttribute("aria-pressed", "true");
    await expect(write).toHaveAttribute("aria-pressed", "false");
  },
);

siteTest(
  "the hero figure holds its still when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/pr-guide/`);

    await expect(browser.locator('[data-figure="pr-guide"]')).toHaveAttribute("data-live", "on");
    await pause(2000);
    expect(await framesSoFar(browser)).toBe(0);
    // The still: revision 2 after the new commit, with two of three chapters checked.
    const commit = screen.getByRole("button", "New commit: show a new commit starting revision 2");
    await expect(commit).toHaveAttribute("aria-pressed", "true");
    expect(await fullyShown(browser, '[data-part="graph-fresh"]')).toBe(true);
    expect(await shownCount(browser, '[data-part$="-pass"]')).toBe(2);

    // A mouse over the drawing changes nothing.
    expect(await sweep(browser, "pr-guide")).toEqual([]);

    // A step still works, and the drawing snaps there without animating: revision 1, two chapters checked.
    const check = screen.getByRole("button", "Check: show prkit checking each chapter's anchors");
    await check.click();
    await expect(check).toHaveAttribute("aria-pressed", "true");
    expect(await fullyShown(browser, '[data-part="graph-fresh"]')).toBe(false);
    expect(await shownCount(browser, '[data-part$="-pass"]')).toBe(2);
    await pause(500);
    expect(await framesSoFar(browser)).toBe(0);
  },
);

/** The inbox rows on show. */
const inboxRows = (browser: Browser) =>
  shownCount(browser, '[data-figure="inbox-list"] [data-row]');

siteTest(
  "the inbox list narrows to one account, stops when scrolled away, and picks with the arrow keys",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/inbox-list/`);

    await expect(screen.getByRole("img", /The prkit window on its Inbox/)).toBeVisible();
    const figure = browser.locator('[data-figure="inbox-list"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    await app.screenshot("www-figure-inbox-list");

    // The tour runs while the figure is on screen: it picks work first.
    const all = screen.getByRole("button", "All accounts: show every account's pull requests");
    const work = screen.getByRole("button", "work: show only this account's pull requests");
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);
    await expect(work).toHaveAttribute("aria-pressed", "true", { timeout: 16_000 });

    // Scrolled away, it asks for no more frames.
    await jumpToEnd(browser);
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, a button narrows the list to one account.
    await figure.scrollIntoView();
    const client = screen.getByRole("button", "client: show only this account's pull requests");
    // Click while the tour shows every account: its next stop is work, so client can only come from the click.
    await expect(all).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(client).toHaveAttribute("aria-pressed", "false");
    await client.click();
    await expect(client).toHaveAttribute("aria-pressed", "true");
    await expect(all).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => inboxRows(browser)).toBe(3);

    // The arrow keys move along the buttons and pick as they go. Escape goes back to every account.
    await client.press("ArrowRight");
    const personal = screen.getByRole("button", "personal: show only this account's pull requests");
    await expect(personal).toBeFocused();
    await expect(personal).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => inboxRows(browser)).toBe(2);
    await personal.press("Escape");
    await expect(all).toBeFocused();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => inboxRows(browser)).toBe(9);
  },
);

siteTest(
  "the inbox list holds every account still when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/inbox-list/`);

    await expect(browser.locator('[data-figure="inbox-list"]')).toHaveAttribute("data-live", "on");
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(0);
    const all = screen.getByRole("button", "All accounts: show every account's pull requests");
    await expect(all).toHaveAttribute("aria-pressed", "true");
    expect(await inboxRows(browser)).toBe(9);

    // A mouse over the drawing changes nothing.
    expect(await sweep(browser, "inbox-list")).toEqual([]);

    // A pick snaps there without animating, and stays past the pause after which the tour would resume.
    const work = screen.getByRole("button", "work: show only this account's pull requests");
    await work.click();
    expect(await inboxRows(browser)).toBe(4);
    await pause(4500);
    await expect(work).toHaveAttribute("aria-pressed", "true");
    expect(await inboxRows(browser)).toBe(4);
    expect(await framesSoFar(browser)).toBe(0);
  },
);

/** The stack layers drawn faint, because another one is picked. */
const faintLayers = (browser: Browser) =>
  browser.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('[data-figure="stack-guides"] [data-lift]')]
        .filter((node) => node.getAttribute("style")?.includes("opacity"))
        .map((node) => node.getAttribute("data-lift") ?? ""),
    ),
  ]);
/** The layers with a written guide: drawn, with no cursor typing in it. */
const writtenGuides = (browser: Browser) =>
  browser.evaluate(
    () =>
      [0, 1, 2].filter((layer) => {
        const shown = (name: string) =>
          document.querySelector(`[data-part="${name}-${layer}"]`)?.getAttribute("visibility") !==
          "hidden";
        return shown("guide") && !shown("cursor");
      }).length,
  );

siteTest(
  "the stack guides write bottom to top, stop when scrolled away, and show one layer at a time",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/stack-guides/`);

    await expect(
      screen.getByRole("img", /A stack of 3 pull requests drawn as app windows/),
    ).toBeVisible();
    const figure = browser.locator('[data-figure="stack-guides"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    await app.screenshot("www-figure-stack-guides");

    // The tour runs while the figure is on screen: it finishes the guides, then shows each layer in turn.
    const first = screen.getByRole("button", "Layer 1: show its pull request and guide");
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);
    await expect(first).toHaveAttribute("aria-pressed", "true", { timeout: 18_000 });

    // Scrolled away, it asks for no more frames.
    await jumpToEnd(browser);
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, a button picks its layer, the others go faint, and Escape lets it go.
    await figure.scrollIntoView();
    const third = screen.getByRole("button", "Layer 3: show its pull request and guide");
    await third.click();
    await expect(third).toHaveAttribute("aria-pressed", "true");
    expect(await faintLayers(browser)).toEqual(["0", "1"]);
    await third.press("Escape");
    await expect(third).toHaveAttribute("aria-pressed", "false");

    // The arrow keys pick the layer they land on.
    await third.press("ArrowLeft");
    const second = screen.getByRole("button", "Layer 2: show its pull request and guide");
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    expect(await faintLayers(browser)).toEqual(["0", "2"]);

    // Whole stack starts from a fresh stack, none of whose layers has a guide, and writes one for each, two at a time.
    await screen
      .getByRole(
        "button",
        "Whole stack: on a fresh stack, write a guide for each open layer without one, bottom to top",
      )
      .click();
    await expect.poll(() => shownCount(browser, '[data-part^="guide-"]')).toBe(0);
    await expect.poll(() => writtenGuides(browser), { timeout: 15_000 }).toBe(3);
  },
);

siteTest(
  "the stack guides hold their rest frame when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/stack-guides/`);

    await expect(browser.locator('[data-figure="stack-guides"]')).toHaveAttribute(
      "data-live",
      "on",
    );
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(0);
    // The rest frame: layers 1 and 2 have their guides, layer 3's is being written.
    expect(await writtenGuides(browser)).toBe(2);
    expect(await faintLayers(browser)).toEqual([]);

    // A mouse over the drawing changes nothing.
    expect(await sweep(browser, "stack-guides", "[data-lift]")).toEqual([]);

    // A layer still gets picked, and stays past the pause after which the tour would resume.
    const first = screen.getByRole("button", "Layer 1: show its pull request and guide");
    await first.click();
    expect(await faintLayers(browser)).toEqual(["1", "2"]);
    await pause(3000);
    await expect(first).toHaveAttribute("aria-pressed", "true");

    // Whole stack snaps to every guide written.
    await screen
      .getByRole(
        "button",
        "Whole stack: on a fresh stack, write a guide for each open layer without one, bottom to top",
      )
      .click();
    expect(await writtenGuides(browser)).toBe(3);
    expect(await framesSoFar(browser)).toBe(0);
  },
);

siteTest(
  "the fix figure makes one commit, waits for Push without pushing, and stops when scrolled away",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/fix-commit/`);

    await expect(
      screen.getByRole("img", /Fixing review comments, in the order it happens/),
    ).toBeVisible();
    const figure = browser.locator('[data-figure="fix-commit"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    await app.screenshot("www-figure-fix-commit");

    // The tour runs while the figure is on screen, and stops when it is scrolled away.
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);
    await jumpToEnd(browser);
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, the tour finishes the batch as one commit and waits at Push.
    await figure.scrollIntoView();
    const push = screen.getByRole("button", "Push: send the commit to GitHub");
    await expect(push).toHaveAttribute("aria-disabled", "false", { timeout: 15_000 });
    expect(await fullyShown(browser, '[data-part="status-ready"]')).toBe(true);
    expect(await fullyShown(browser, '[data-part="commit-line"]')).toBe(true);

    // Well after the tour ends it still has not pushed, and it waits without asking for frames.
    await pause(1000);
    const waiting = await framesSoFar(browser);
    await pause(3000);
    expect(await framesSoFar(browser)).toBe(waiting);
    expect(await shownCount(browser, '[data-part="status-pushed"]')).toBe(0);

    // Only the reader's Push sends it.
    await push.click();
    await expect(push).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => fullyShown(browser, '[data-part="status-pushed"]')).toBe(true);
  },
);

siteTest(
  "the fix figure waits ready to push, and pushes at once, when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/fix-commit/`);

    await expect(browser.locator('[data-figure="fix-commit"]')).toHaveAttribute("data-live", "on");
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(0);
    expect(await fullyShown(browser, '[data-part="status-ready"]')).toBe(true);
    expect(await shownCount(browser, '[data-part="status-pushed"]')).toBe(0);

    // A mouse over the drawing, Push included, changes nothing.
    expect(await sweep(browser, "fix-commit", '[data-part="push-hit"]')).toEqual([]);

    // Push snaps straight to pushed, and there is nothing left to push.
    const push = screen.getByRole("button", "Push: send the commit to GitHub");
    await expect(push).toHaveAttribute("aria-disabled", "false");
    await push.click();
    expect(await fullyShown(browser, '[data-part="status-pushed"]')).toBe(true);
    await expect(push).toHaveAttribute("aria-disabled", "true");
    expect(await framesSoFar(browser)).toBe(0);
  },
);

siteTest(
  "the local-first diagram follows its two connections and stops when scrolled away",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await app.open(`${site}figures/local-only/`);

    await expect(
      screen.getByRole("img", /Local first, as a diagram of the software on your Mac/),
    ).toBeVisible();
    const figure = browser.locator('[data-figure="local-only"]');
    await expect(figure).toHaveAttribute("data-live", "on");
    await app.screenshot("www-figure-local-only");

    // The tour runs while the figure is on screen: a request carries a token out to GitHub.
    const before = await framesSoFar(browser);
    await expect.poll(() => framesSoFar(browser)).toBeGreaterThan(before + 10);
    await expect
      .poll(() => shownCount(browser, '[data-part^="token-"]'), { timeout: 13_000 })
      .toBe(1);

    // Scrolled away, it asks for no more frames.
    await jumpToEnd(browser);
    await pause(500);
    const away = await framesSoFar(browser);
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(away);

    // Back in view, a button follows one connection: the token goes out to GitHub's API.
    await figure.scrollIntoView();
    const github = screen.getByRole(
      "button",
      "GitHub: show a request carrying your token to GitHub",
    );
    await github.click();
    await expect(github).toHaveAttribute("aria-pressed", "true");
    expect(await shownCount(browser, '[data-part^="token-"]')).toBe(1);
    expect(await shownCount(browser, '[data-part^="api-"]')).toBe(1);

    // The arrow keys move along the buttons, following each; Escape goes back to the whole picture.
    await github.press("ArrowRight");
    const agent = screen.getByRole(
      "button",
      "Your agent: show a job going to your agent, without your GitHub token",
    );
    await expect(agent).toBeFocused();
    await expect(agent).toHaveAttribute("aria-pressed", "true");
    expect(await fullyShown(browser, '[data-part="copy-lit"]')).toBe(true);
    expect(await shownCount(browser, '[data-part^="token-"]')).toBe(0);
    await agent.press("Escape");
    await expect(agent).toHaveAttribute("aria-pressed", "false");
    expect(await shownCount(browser, '[data-part="copy-lit"]')).toBe(0);
  },
);

siteTest(
  "the local-first diagram holds still when the system asks for less motion",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countFrames);
    await browser.addInitScript(lessMotion);
    await app.open(`${site}figures/local-only/`);

    await expect(browser.locator('[data-figure="local-only"]')).toHaveAttribute("data-live", "on");
    await pause(1500);
    expect(await framesSoFar(browser)).toBe(0);
    // At rest no connection is lit and the search has not run.
    expect(await shownCount(browser, '[data-part^="token-"]')).toBe(0);
    expect(await shownCount(browser, '[data-part="empty"]')).toBe(0);

    // A mouse over the drawing changes nothing.
    expect(
      await sweep(
        browser,
        "local-only",
        '[data-part^="token-"], [data-part^="api-"], [data-part="copy-lit"], [data-part="empty"]',
      ),
    ).toEqual([]);

    // The disk search snaps to its answer without animating, and stays.
    const disk = screen.getByRole("button", "Disk: search prkit's data folder for a GitHub token");
    await disk.click();
    await expect(disk).toHaveAttribute("aria-pressed", "true");
    expect(await fullyShown(browser, '[data-part="empty"]')).toBe(true);
    await pause(3000);
    expect(await fullyShown(browser, '[data-part="empty"]')).toBe(true);
    expect(await framesSoFar(browser)).toBe(0);
  },
);

// The download surfaces. The build derives the repository from GITHUB_URL, so these journeys serve
// the page as built for a placeholder repository and answer GitHub's API themselves.
const RELEASE_API = "https://api.github.com/repos/octocat/prkit/releases/latest";
const RELEASES = "https://github.com/octocat/prkit/releases";
const DMG = `${RELEASES}/download/v0.1.0/prkit-0.1.0-arm64.dmg`;
const NOTES = `${RELEASES}/tag/v0.1.0`;
const STABLE = {
  tag_name: "v0.1.0",
  name: "prkit 0.1.0",
  draft: false,
  prerelease: false,
  html_url: NOTES,
  assets: [
    { name: "prkit-0.1.0-arm64.dmg", browser_download_url: DMG },
    { name: "prkit-0.1.0-arm64.zip", browser_download_url: `${DMG.slice(0, -4)}.zip` },
    { name: "latest-mac.yml", browser_download_url: `${RELEASES}/download/v0.1.0/latest-mac.yml` },
  ],
};
const DOWNLOAD_NAME = "Download prkit 0.1.0 for macOS, Apple Silicon";

/** Adds up every layout shift the page makes, the way Cumulative Layout Shift counts them. */
const countShifts = `(() => {
  window.__shift = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shift += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
})()`;
const shiftSoFar = (browser: Browser) =>
  browser.evaluate(() => Number(Reflect.get(window, "__shift")));

/**
 * Opens the page as built for the placeholder repository, with GitHub's answer to the latest
 * release given by `answer`. `scripts: false` serves it with every script blocked, as a reader with
 * JavaScript off sees it. Returns how many times the page asked.
 */
async function openWithRelease(
  {
    app,
    browser,
    site,
  }: { app: { open: (url: string) => Promise<void> }; browser: Browser; site: string },
  answer: (route: WebRoute) => Promise<void>,
  { scripts = true } = {},
) {
  const page = NodeFS.readFileSync(NodePath.join(dist, "index.html"), "utf8");
  const built = page.replace(
    /data-release-repo(?:="[^"]*")?(?=[\s>])/,
    'data-release-repo="octocat/prkit"',
  );
  expect(built).toContain('data-release-repo="octocat/prkit"');
  await browser.route(site, (route) =>
    route.fulfill({
      body: built,
      contentType: "text/html; charset=utf-8",
      headers: scripts ? {} : { "content-security-policy": "script-src 'none'" },
    }),
  );
  const asked = { count: 0 };
  await browser.route(RELEASE_API, async (route) => {
    asked.count += 1;
    expect(route.request.headers.accept).toBe("application/vnd.github+json");
    await answer(route);
  });
  await app.open(site);
  return asked;
}

/** What the download surfaces say and where they lead. */
const downloadState = (browser: Browser) =>
  browser.evaluate(() => {
    const shown = (node: Element) =>
      getComputedStyle(node).visibility === "visible" && node.getClientRects().length > 0;
    const page = document.documentElement;
    return {
      release: page.dataset.release ?? "soon",
      // Every link with somewhere to go into the disk image, release notes or the release list.
      downloads: [...document.querySelectorAll<HTMLAnchorElement>("a[data-release-link][href]")]
        .filter(shown)
        .map((link) => `${link.dataset.releaseLink} ${link.href}`),
      soon: [...document.querySelectorAll('[data-release-part="soon"]')]
        .filter(shown)
        // The band's state opens with its heading; the others are one line each.
        .map((node) => (node.firstElementChild ?? node).textContent?.trim() ?? ""),
      nightly: /nightly/i.test(
        [
          page.textContent ?? "",
          ...[...document.querySelectorAll("a")].map((link) => link.href),
          ...[...document.querySelectorAll("[aria-label]")].map((node) =>
            node.getAttribute("aria-label"),
          ),
        ].join(" "),
      ),
    };
  });

const COMING_SOON = {
  release: "soon",
  downloads: [],
  soon: ["Soon", "Coming soon to macOS", "Coming soon", "Coming soon to your Mac."],
  nightly: false,
};

/** Waits until the page has asked for the release, then a moment longer for it to act on the answer. */
async function settled(asked: { count: number }) {
  for (let waited = 0; asked.count === 0 && waited < 5_000; waited += 50) await pause(50);
  expect(asked.count).toBe(1);
  await pause(500);
}

siteTest(
  "the download says coming soon while GitHub has no stable release",
  async ({ app, screen, browser, site }) => {
    const asked = await openWithRelease({ app, browser, site }, (route) =>
      route.fulfill({ status: 404, json: { message: "Not Found" } }),
    );
    await settled(asked);
    expect(await downloadState(browser)).toEqual(COMING_SOON);
    await expect(screen.getByText("Coming soon to macOS")).toBeVisible();
    await expect(screen.getByRole("link", DOWNLOAD_NAME)).toHaveCount(0);
    await expect(screen.getByRole("link", /^Download\s*Soon\W*for macOS$/)).toBeVisible();

    // A 404 is remembered for the session: a reload does not ask again.
    await browser.reload();
    await pause(500);
    expect(asked.count).toBe(1);
    expect(await downloadState(browser)).toEqual(COMING_SOON);
  },
);

siteTest(
  "a stable release turns on every download surface in place",
  async ({ app, screen, browser, site }) => {
    await browser.addInitScript(countShifts);
    const asked = await openWithRelease({ app, browser, site }, (route) =>
      route.fulfill({ json: STABLE }),
    );
    await expect(browser.locator("html")).toHaveAttribute("data-release", "ready");
    await pause(500);
    expect(await downloadState(browser)).toEqual({
      release: "ready",
      downloads: [`dmg ${DMG}`, `dmg ${DMG}`, `notes ${NOTES}`, `all ${RELEASES}`],
      soon: [],
      nightly: false,
    });

    // The hero's label became the link, named for what it downloads, and the chip says so.
    await expect(screen.getByRole("link", DOWNLOAD_NAME)).toHaveCount(2);
    await expect(screen.getByText("0.1.0 is out for macOS")).toBeVisible();
    await expect(screen.getByText("Coming soon to macOS")).toBeHidden();
    // The header pill still leads to the band, without "Soon".
    await expect(screen.getByRole("link", /^Download\W*for macOS$/)).toHaveAttribute(
      "href",
      "#download",
    );
    const band = screen.getByRole("region", "prkit 0.1.0 for your Mac.");
    await band.scrollIntoView();
    await expect(band).toBeVisible();
    await expect(
      screen.getByText("Needs a Mac with Apple Silicon and macOS 13 Ventura or later."),
    ).toBeVisible();
    await expect(screen.getByRole("link", "Release notes")).toHaveAttribute("href", NOTES);
    await expect(screen.getByRole("link", "All releases")).toHaveAttribute("href", RELEASES);
    await expect(screen.getByRole("heading", "Coming soon to your Mac.")).toBeHidden();

    // Nothing moved when the surfaces switched: the boxes were already the size of both states.
    const shift = await shiftSoFar(browser);
    console.log(`layout shift with a stable release: ${shift.toFixed(4)}`);
    expect(shift).toBeLessThan(0.01);

    // A found release is remembered for the session.
    await browser.reload();
    await expect(browser.locator("html")).toHaveAttribute("data-release", "ready");
    expect(asked.count).toBe(1);
  },
);

siteTest(
  "a refused, failed or slow lookup leaves the download coming soon",
  async ({ app, browser, site }) => {
    const answers: Array<[string, (route: WebRoute) => Promise<void>]> = [
      ["rate limited", (route) => route.fulfill({ status: 403, json: { message: "rate limit" } })],
      ["network failure", (route) => route.abort()],
      ["not JSON", (route) => route.fulfill({ body: "<html>", contentType: "text/html" })],
    ];
    for (const [, answer] of answers) {
      const asked = await openWithRelease({ app, browser, site }, answer);
      await settled(asked);
      expect(await downloadState(browser)).toEqual(COMING_SOON);
      await browser.unroute(RELEASE_API);
      await browser.unroute(site);
      // Failures are not remembered: a fresh session would ask again.
      await browser.evaluate(() => {
        sessionStorage.clear();
        return null;
      });
    }

    // A stable release that arrives after the page stopped waiting (5 s) changes nothing.
    const asked = await openWithRelease({ app, browser, site }, async (route) => {
      await pause(6_000);
      await route.fulfill({ json: STABLE }).catch(() => undefined);
    });
    await pause(7_000);
    expect(asked.count).toBe(1);
    expect(await downloadState(browser)).toEqual(COMING_SOON);
  },
);

siteTest(
  "with JavaScript off the download says coming soon",
  async ({ app, screen, browser, site }) => {
    const asked = await openWithRelease(
      { app, browser, site },
      (route) => route.fulfill({ json: STABLE }),
      { scripts: false },
    );
    await pause(1_000);
    expect(asked.count).toBe(0);
    expect(await downloadState(browser)).toEqual(COMING_SOON);
    await expect(screen.getByText("Coming soon to macOS")).toBeVisible();
  },
);
