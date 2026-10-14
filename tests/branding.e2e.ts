import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl, serverBuildId, serverVersion } from "../scripts/verify-run.ts";

test("prkit boots on its splash and favicon, with fonts served by prkit itself", async ({
  app,
  screen,
  browser,
}) => {
  const run = runForUrl(app.baseUrl);
  const fontRequests: Array<string> = [];
  await browser.route(/\.(woff2?|ttf|otf)(\?|$)/, async (route) => {
    fontRequests.push(route.request.url);
    await route.continue();
  });
  // Without the app's entry script the page stays on what index.html paints before React.
  await browser.route("**/assets/index-*.js", (route) => route.abort());
  await app.open(run.openUrl);
  await expect(screen.getByRole("img", "prkit")).toBeVisible();
  await expect(browser).toHaveTitle("prkit");
  await expect(browser.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  await app.screenshot("boot-splash");
  const favicon = await fetch(new URL("/favicon.svg", run.url));
  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("content-type")).toContain("image/svg+xml");

  await browser.unroute("**/assets/index-*.js");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  const fonts = await browser.evaluate(async () => {
    // The italic face downloads only when text uses it, so ask for it the way markdown's <em> does.
    await document.fonts.load('italic 400 1em "Fira Sans"');
    return {
      body: getComputedStyle(document.body).fontFamily,
      loaded: [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map(
          (face) =>
            `${face.family.replaceAll('"', "")} ${face.weight}${face.style === "italic" ? " italic" : ""}`,
        ),
    };
  });
  expect(fonts.body).toMatch(/^"Fira Sans"/);
  for (const face of [
    "Fira Sans 400",
    "Fira Sans 400 italic",
    "Fira Sans 500",
    "Fira Sans 600",
    "JetBrains Mono 400",
  ])
    expect(fonts.loaded).toContain(face);
  expect(fontRequests.length).toBeGreaterThan(0);
  expect(fontRequests.filter((url) => !url.startsWith(`${run.url}/assets/`))).toEqual([]);
});

test("Settings > About shows the mark, the tagline, the version and the build", async ({
  app,
  screen,
  browser,
}) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "About").tap();
  const about = screen.getByRole("region", "About prkit");
  await expect(about.getByRole("img", "prkit")).toBeVisible();
  await expect(about).toContainText("Stay in the loop when agents write the code.");
  await expect(about).toContainText(`Version ${serverVersion()}`);
  await expect(about).toContainText(`Build ${serverBuildId()}`);
  await app.screenshot("settings-about");
});
