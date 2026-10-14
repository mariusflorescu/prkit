/**
 * Captures the website's product shots from a running verification instance, in light and
 * dark at 2x, into src/assets/shots/:
 *
 *   pnpm verify:app start --name www --detach
 *   pnpm --filter @prkit/www shots [instance name, default www]
 *
 * A light and a dark page stay open side by side, so a shot of something live, such as a guide
 * being written, shows the same moment in both. On a fresh home it asks Claude for the fixture
 * PR's guide and sends one draft comment to the fix agent, two turns of the user's subscription;
 * the fix stays a local commit and is never pushed. The progress shots come from that guide run,
 * so a home that already has the guide keeps the ones on disk. Every frame from the server goes
 * through clientSafeSocket.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { type Browser, chromium, type Locator, type Page } from "playwright";
import sharp from "sharp";

import {
  ALIAS,
  type Json,
  createClientSafeSocket,
  isObject,
  type ReviewRequest,
  shownFixture,
  text,
} from "./clientSafeSocket.ts";

type Size = { width: number; height: number };
type Rect = Size & { x: number; y: number };

// The hero is a whole window. Feature shots share one 16:10 frame, cut above the inbox footer,
// which names the instance's home directory.
const HERO: Size = { width: 1280, height: 800 };
const FEATURE: Size = { width: 960, height: 640 };
const FEATURE_CLIP: Rect = { x: 0, y: 0, width: 960, height: 600 };
// Wide and tall enough that the progress and the changed files fit in one frame.
const LIVE: Size = { width: 1200, height: 1000 };
const AGENT_WAIT = 15 * 60_000;
const outDir = new URL("../src/assets/shots/", import.meta.url);
const liveDir = new URL("../../../.e2e/evidence/www-shots/live/", import.meta.url);
const instance = process.argv[2] ?? "www";

/** The PR tabs every shot shows, in order: the guided PR, two layers of the stack, one more. */
const TABS = [1, 191, 192, 2];
const GUIDED = 1;
const STACKED = 191;
const UNGUIDED = 2;
/** Fixture PRs the journeys keep open and no shot opens, shown as teammates asking for review. */
const REVIEW_REQUESTS: Array<ReviewRequest> = [
  { number: 447, author: "acme-sam" },
  { number: 103, author: "acme-riley" },
];
const FIX_FILE = "src/validate.js";
const FIX_LINE = 6;
const FIX_COMMENT =
  "Trim the input before parsing it, so a link pasted with a trailing space or newline still works.";

const readOpenUrl = (): string => {
  const runFile = new URL(`../../../.e2e/run/${instance}.json`, import.meta.url);
  const run: Json = JSON.parse(readFileSync(runFile, "utf8"));
  const openUrl = isObject(run) ? text(run.openUrl) : "";
  if (!openUrl) throw new Error(`${runFile.pathname} has no openUrl. Start the instance first.`);
  return openUrl;
};

// The page sees the placeholders; the socket gives the server the real names back.
const pr = (number: number, tab: "conversation" | "files" | "guide" | "fixes") =>
  `/pr/github.com/${ALIAS.owner}/${ALIAS.repo}/${number}?account=${encodeURIComponent(`github.com/${ALIAS.owner}`)}&tab=${tab}`;

/**
 * Wheels the PR view, as a user would, until `target` sits `offset` pixels below the pinned
 * header. The header collapses on the first scroll and moves everything, so it wheels twice.
 */
const scrollTo = async (target: Locator, offset: number) => {
  const page = target.page();
  for (const _pass of [1, 2]) {
    const scroller = await page.locator("[data-pr-scroll]").boundingBox();
    const header = await page.locator("[data-collapse-pinned]").first().boundingBox();
    const box = await target.boundingBox();
    if (!scroller || !header || !box) throw new Error("scrollTo: the PR view is not on screen");
    await page.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);
    await page.mouse.wheel(0, box.y - (header.y + header.height) - offset);
    await page.waitForTimeout(400);
  }
};

/**
 * A 16:10 frame around every element, with at least `margin` pixels on each side. It starts
 * just above the first element and grows down, so its top edge never cuts through the app.
 */
const frameAround = async (elements: Array<Locator>, margin: number): Promise<Rect> => {
  const boxes = await Promise.all(elements.map((element) => element.boundingBox()));
  const top = Math.min(...boxes.map((box) => box?.y ?? Infinity));
  const left = Math.min(...boxes.map((box) => box?.x ?? Infinity));
  const bottom = Math.max(...boxes.map((box) => (box ? box.y + box.height : -Infinity)));
  const right = Math.max(...boxes.map((box) => (box ? box.x + box.width : -Infinity)));
  if (boxes.some((box) => box === null))
    throw new Error("frameAround: an element is not on screen");
  const fitted = { width: right - left + margin * 2, height: bottom - top + margin * 2 };
  const width = Math.round(Math.max(fitted.width, fitted.height * 1.6));
  return {
    x: Math.round((left + right - width) / 2),
    y: Math.round(top - margin),
    width,
    height: Math.round(width / 1.6),
  };
};

type Shot = {
  name: string;
  path: string;
  ready: (page: Page) => Promise<void>;
  viewport?: Size;
  /** Defaults to FEATURE_CLIP; null keeps the whole window. */
  clip?: ((page: Page) => Promise<Rect>) | null;
};

const shots: Array<Shot> = [
  {
    name: "guide",
    path: pr(GUIDED, "guide"),
    ready: (page) => scrollTo(page.getByRole("region", { name: "Before and after" }), 24),
    viewport: HERO,
    clip: null,
  },
  {
    name: "inbox",
    path: "/",
    ready: async (page) => {
      await page.getByRole("link", { name: /^Inbox/ }).click();
      // The first read asks every account, which takes a while on a busy machine.
      await page.getByRole("region", { name: "Yours" }).waitFor({ timeout: 90_000 });
      await page.locator("[data-guide-mark]").first().waitFor();
    },
  },
  {
    name: "conversation",
    path: pr(GUIDED, "conversation"),
    ready: (page) => page.getByText("opened this pull request").waitFor(),
  },
  {
    name: "watching",
    path: pr(GUIDED, "guide"),
    ready: (page) =>
      page.getByRole("status", { name: "Guide status" }).filter({ hasText: "Watching" }).waitFor(),
  },
  {
    name: "fixes",
    path: pr(GUIDED, "fixes"),
    ready: async (page) => {
      const turn = page.getByRole("article", { name: /: Ready to review$/ }).first();
      await turn.waitFor();
      await scrollTo(turn, 10);
    },
  },
  {
    name: "stack",
    path: pr(STACKED, "guide"),
    ready: async (page) => {
      await page.getByRole("navigation", { name: "Stack" }).waitFor();
      await page.getByText("No files skipped").waitFor();
      await page.getByRole("radio", { name: /^Whole stack/ }).click();
      await page.getByRole("button", { name: /^Generate \d guides$/ }).waitFor();
      // A focused composer draws its ring, which reads as an error in a still picture.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
    },
  },
  {
    name: "providers",
    path: pr(UNGUIDED, "guide"),
    ready: async (page) => {
      await page.getByText("No files skipped").waitFor();
      await page.getByRole("button", { name: /^Agent and model: / }).click();
      await page.getByRole("listbox").getByText("Codex", { exact: true }).waitFor();
    },
    // The picker is the subject here, so the frame zooms in on it.
    viewport: { width: 1200, height: 900 },
    clip: (page) =>
      frameAround(
        [page.getByRole("form", { name: "Start a guide" }), page.getByRole("listbox")],
        40,
      ),
  },
];

type Scheme = {
  name: "light" | "dark";
  page: Page;
  socket: ReturnType<typeof createClientSafeSocket>;
};

const save = async (png: Buffer, name: string, scheme: Scheme["name"], filtered: number) => {
  const file = new URL(`${name}-${scheme}.webp`, outDir);
  await sharp(png).webp({ quality: 92 }).toFile(file.pathname);
  console.log(`${file.pathname} (checked against ${filtered} hidden names)`);
};

/**
 * The server keeps the open tabs, so one page arranging them arranges them for both. Each change
 * goes over the socket after the page shows it, so the page waits before it navigates away.
 */
const arrangeTabs = async (page: Page, openUrl: string) => {
  const tabs = page.getByRole("navigation", { name: "Workspace tabs" }).locator("[data-open-pr]");
  const none = page.getByText("No open pull requests");
  await tabs.first().or(none).first().waitFor();
  if ((await tabs.count()) > 0) {
    await tabs.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close all PRs" }).click();
    await none.waitFor();
    await page.waitForTimeout(1_000);
  }
  for (const number of TABS) {
    await page.goto(new URL(pr(number, "conversation"), openUrl).href);
    await page.locator(`[data-open-pr$="#${number}"]`).waitFor();
    await page.waitForTimeout(1_000);
  }
  await page.reload();
  await tabs.first().waitFor();
  const order = await tabs.evaluateAll((links) =>
    links.map((link) => link.getAttribute("data-open-pr")?.replace(/.*(?=#)/, "") ?? ""),
  );
  const expected = TABS.map((number) => `#${number}`);
  if (order.join(" ") !== expected.join(" ")) {
    throw new Error(`The tabs read ${order.join(" ")} instead of ${expected.join(" ")}.`);
  }
};

/**
 * Asks Claude for the guided PR's guide while both pages watch, keeping a light and dark pair
 * each time the progress changes. The last pair before the draft appears becomes the progress
 * shot; every pair, draft included, is kept under .e2e/evidence/www-shots/live/.
 */
const writeGuide = async (lead: Scheme, schemes: Array<Scheme>, openUrl: string) => {
  const generate = (page: Page) => page.getByRole("button", { name: "Generate guide" });
  const revision = (page: Page) => page.getByRole("combobox", { name: "Guide revision" });
  for (const { page } of schemes) {
    await page.setViewportSize(LIVE);
    await page.goto(new URL(pr(GUIDED, "guide"), openUrl).href);
    await generate(page).or(revision(page)).first().waitFor({ timeout: 30_000 });
  }
  if (await revision(lead.page).isVisible()) {
    console.log("The guide exists: keeping the progress shots on disk.");
    return;
  }
  console.log("No guide yet: asking Claude for one (one subscription turn).");
  mkdirSync(liveDir, { recursive: true });
  await generate(lead.page).click();

  const progressOf = (page: Page) =>
    page.evaluate(() => ({
      read: document.querySelectorAll('[data-attempt-file][data-read="read"]').length,
      notes: document.querySelectorAll("[data-file-note]").length,
      narration: document.querySelector("[data-narration]")?.textContent ?? "",
      draft: document.querySelector("[data-guide-summary]") !== null,
      chapters: document.querySelectorAll("[data-roadmap-row]:not([data-pending])").length,
      failed: document.querySelector('[data-review-status="failed"]') !== null,
    }));
  const deadline = Date.now() + AGENT_WAIT;
  let last = "";
  let frames = 0;
  let reading: Array<{ scheme: Scheme; png: Buffer; filtered: number }> = [];
  while (!(await revision(lead.page).filter({ hasText: "r1 · " }).isVisible())) {
    if (Date.now() > deadline) throw new Error("The guide took longer than 15 minutes.");
    const progress = await progressOf(lead.page);
    if (progress.failed) throw new Error("The guide failed; see the instance log.");
    const signature = JSON.stringify(progress);
    if (signature !== last && (progress.read > 0 || progress.notes > 0 || progress.draft)) {
      last = signature;
      frames += 1;
      const pair = await Promise.all(
        schemes.map(async (scheme) => {
          // The other page renders the same frame a moment later.
          await scheme.page
            .waitForFunction(
              (expected) => {
                const notes = document.querySelectorAll("[data-file-note]").length;
                const draft = document.querySelector("[data-guide-summary]") !== null;
                return notes === expected.notes && draft === expected.draft;
              },
              progress,
              { timeout: 2_000 },
            )
            .catch(() => undefined);
          const filtered = await scheme.socket.assertClean(scheme.page, "progress");
          const png = progress.draft
            ? await scheme.page.screenshot()
            : await scheme.page.screenshot({
                // The tab bar sits right above the progress, so the frame keeps 20 pixels clear.
                clip: await frameAround(
                  [
                    scheme.page.locator("#guide-progress-title"),
                    scheme.page.locator("[data-attempt-file]").last(),
                  ],
                  20,
                ),
              });
          writeFileSync(new URL(`${frames}-${scheme.name}.png`, liveDir), png);
          return { scheme, png, filtered };
        }),
      );
      if (!progress.draft) reading = pair;
    }
    await lead.page.waitForTimeout(250);
  }
  console.log(`Guide written; kept ${frames} live frames in ${liveDir.pathname}.`);
  if (reading.length === 0) throw new Error("No frame showed the agent reading the PR.");
  for (const { scheme, png, filtered } of reading)
    await save(png, "progress", scheme.name, filtered);
};

/** Sends one draft comment on the guided PR to the fix agent and waits for its commit. */
const askForFix = async (page: Page, openUrl: string) => {
  await page.goto(new URL(pr(GUIDED, "fixes"), openUrl).href);
  const turn = page.getByRole("article", { name: /^Fix / }).first();
  // A PR with nothing sent yet has no Fixes tab, so the link opens Conversation.
  const conversation = page
    .getByRole("navigation", { name: "Pull request tabs" })
    .getByRole("link", { name: /^Conversation/ })
    .and(page.locator('[aria-current="page"]'));
  await turn.or(conversation).first().waitFor({ timeout: 30_000 });
  if (await turn.isVisible()) return;
  console.log("No fix yet: sending one draft to the agent (one subscription turn).");
  await page.goto(new URL(pr(GUIDED, "files"), openUrl).href);
  const line = (number: number) =>
    page.locator(`[data-path="${FIX_FILE}"] [data-column-number="${number}"]`);
  const gutter = page.locator(`[data-path="${FIX_FILE}"] [data-utility-button]`);
  await line(FIX_LINE).scrollIntoViewIfNeeded();
  // The diff re-renders once highlighted, which can drop an early hover.
  for (let tries = 0; (await gutter.count()) === 0; tries += 1) {
    if (tries > 30) throw new Error(`No comment button on ${FIX_FILE} line ${FIX_LINE}.`);
    await line(FIX_LINE - 1).hover();
    await line(FIX_LINE).hover();
    await page.waitForTimeout(500);
  }
  await gutter.click();
  const comment = page.getByRole("textbox", { name: `Comment on line ${FIX_LINE}` });
  await comment.fill(FIX_COMMENT);
  await comment.press("Meta+Enter");
  await page.getByRole("button", { name: "Review, 1 pending" }).first().click();
  await page
    .getByRole("group", { name: "Where your comments go" })
    .getByRole("button", { name: "Send to agent" })
    .click();
  await page
    .getByRole("dialog", { name: "Send to agent" })
    .getByRole("button", { name: "Send 1 comment to agent" })
    .click();
  await page.goto(new URL(pr(GUIDED, "fixes"), openUrl).href);
  await page
    .getByRole("article", { name: /: Ready to review$/ })
    .first()
    .waitFor({ timeout: AGENT_WAIT });
};

const openScheme = async (browser: Browser, name: Scheme["name"], openUrl: string) => {
  const context = await browser.newContext({
    viewport: HERO,
    deviceScaleFactor: 2,
    colorScheme: name,
    reducedMotion: "reduce",
  });
  const socket = createClientSafeSocket(shownFixture(), REVIEW_REQUESTS);
  await socket.install(context);
  const page = await context.newPage();
  await page.goto(openUrl);
  await page.getByRole("navigation", { name: "Workspace tabs" }).waitFor({ timeout: 60_000 });
  return { name, page, socket };
};

const openUrl = readOpenUrl();
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-mock-keychain"] });
try {
  const light = await openScheme(browser, "light", openUrl);
  const schemes = [light, await openScheme(browser, "dark", openUrl)];
  await arrangeTabs(light.page, openUrl);
  await writeGuide(light, schemes, openUrl);
  await askForFix(light.page, openUrl);

  for (const shot of shots) {
    for (const scheme of schemes) {
      const { page } = scheme;
      const viewport = shot.viewport ?? FEATURE;
      await page.setViewportSize(viewport);
      await page.goto(new URL(shot.path, openUrl).href);
      await shot.ready(page);
      await page.mouse.move(0, viewport.height - 1);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const filtered = await scheme.socket.assertClean(page, shot.name);
      const clip = shot.clip === undefined ? FEATURE_CLIP : shot.clip && (await shot.clip(page));
      await save(await page.screenshot(clip ? { clip } : {}), shot.name, scheme.name, filtered);
    }
  }
} finally {
  await browser.close();
}
