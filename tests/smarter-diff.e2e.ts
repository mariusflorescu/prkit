import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { draftOn, type Fixtures, fixesTab, openSendToAgent, pickModel } from "./fixActions.ts";
import { FIXTURE_REPO, NEEDS_FIXTURE, prPath } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import {
  closeSmarterDiffFixture,
  createSmarterDiffFixture,
  FIX_EDITS,
  SMARTER_DIFF,
} from "./smarterDiffFixture.ts";

/** A stand-in agent's fix, from the draft to Ready. */
const TURN_WAIT = 180_000;
const MOVED_FROM_LINKS = new RegExp(`^Show src/links\\.js lines ${SMARTER_DIFF.cutAt}-\\d+$`);
const MOVED_TO_URLS = new RegExp(`^Show src/urls\\.js lines ${SMARTER_DIFF.landedAt}-\\d+$`);

const Row = Schema.NullOr(
  Schema.Struct({
    background: Schema.String,
    selected: Schema.Boolean,
    top: Schema.Number,
    bottom: Schema.Number,
    viewport: Schema.Number,
  }),
);
const decodeRow = Schema.decodeSync(Schema.fromJsonString(Row));

/** One code row of a card's diff, read inside its shadow root: its look and where it is. */
const rowOf = async ({ browser }: Fixtures, path: string, side: "old" | "new", line: number) =>
  decodeRow(
    await browser.evaluate(
      ({ path, type, line }) => {
        const root = document.querySelector(`[data-path="${path}"] diffs-container`)?.shadowRoot;
        const row = root?.querySelector(
          `[data-line][data-line-type="${type}"][data-line="${line}"]`,
        );
        if (!row) return "null";
        const box = row.getBoundingClientRect();
        return JSON.stringify({
          background: getComputedStyle(row).backgroundColor,
          selected: row.hasAttribute("data-selected-line"),
          top: box.top,
          bottom: box.bottom,
          viewport: window.innerHeight,
        });
      },
      { path, type: side === "old" ? "change-deletion" : "change-addition", line },
    ),
  );

/** The scope text in a card's separators, in order, and their heights. */
const scopesOf = async ({ browser }: Fixtures, path: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({ text: Schema.String, title: Schema.String, height: Schema.Number }),
      ),
    ),
  )(
    await browser.evaluate((path) => {
      const root = document.querySelector(`[data-path="${path}"] diffs-container`)?.shadowRoot;
      return JSON.stringify(
        [...(root?.querySelectorAll<HTMLElement>("[data-scope]") ?? [])].map((scope) => {
          const separator = scope.closest<HTMLElement>("[data-separator]");
          return {
            text: scope.textContent ?? "",
            title: separator?.title ?? "",
            height: separator?.getBoundingClientRect().height ?? 0,
          };
        }),
      );
    }, path),
  );

const inView = (row: { top: number; bottom: number; viewport: number } | null) =>
  row !== null && row.top >= 0 && row.bottom <= row.viewport;

describe("smarter diffs on a refactor", { skip: NEEDS_FIXTURE }, () => {
  test(
    "moved code reads as a move and a deep hunk names its scope, in Files, the guide and Fixes",
    { timeout: 900_000 },
    async (fixtures) => {
      const { app, screen, browser } = fixtures;
      const claude = setUpFakeClaude("smarter-diff");
      const fixture = createSmarterDiffFixture(`${Date.now()}`);
      const run = startInstance("smarter-diff", ["--claude", claude.file]);
      try {
        await emulateOsColorScheme(browser, "light");
        await app.open(run.openUrl);
        await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "files")}`);

        const urls = screen.getByRole("region", SMARTER_DIFF.urls);
        const links = screen.getByRole("region", SMARTER_DIFF.links);
        const report = screen.getByRole("region", SMARTER_DIFF.report);
        await expect(urls.getByRole("button", MOVED_FROM_LINKS)).toBeVisible({ timeout: 60_000 });
        await links.scrollIntoView();
        await expect(links.getByRole("button", MOVED_TO_URLS)).toBeVisible({ timeout: 30_000 });
        await report.scrollIntoView();
        await expect(
          report.getByRole(
            "button",
            `Show src/report.js lines ${SMARTER_DIFF.rowCutAt}-${SMARTER_DIFF.rowCutAt + 5}`,
          ),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          report.getByRole(
            "button",
            `Show src/report.js lines ${SMARTER_DIFF.rowLandedAt}-${SMARTER_DIFF.rowLandedAt + 5}`,
          ),
        ).toBeVisible();

        // The moved body is quiet; the line that changed on the way stays an addition.
        await urls.scrollIntoView();
        const moved = await rowOf(fixtures, SMARTER_DIFF.urls, "new", SMARTER_DIFF.landedAt);
        const edited = await rowOf(fixtures, SMARTER_DIFF.urls, "new", SMARTER_DIFF.editedAt);
        const added = await rowOf(fixtures, SMARTER_DIFF.urls, "new", SMARTER_DIFF.addedAt);
        expect(moved?.background).not.toBe(added?.background);
        expect(edited?.background).toBe(added?.background);
        await screenshotLightAndDark(app, browser, "files-moved-from");

        // The chip takes the reader to where the body was cut, on the old side.
        await urls.getByRole("button", MOVED_FROM_LINKS).tap();
        await expect
          .poll(
            async () => {
              const cut = await rowOf(fixtures, SMARTER_DIFF.links, "old", SMARTER_DIFF.cutAt);
              return cut?.selected === true && inView(cut);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        await screenshotLightAndDark(app, browser, "files-jumped-to-cut");
        await links.getByRole("button", MOVED_TO_URLS).tap();
        await expect
          .poll(
            async () => {
              const landed = await rowOf(fixtures, SMARTER_DIFF.urls, "new", SMARTER_DIFF.landedAt);
              return landed?.selected === true && inView(landed);
            },
            { timeout: 15_000 },
          )
          .toBe(true);

        // One line deep in a method: the separator above it names every opener it hides,
        // in the row it already had.
        const router = screen.getByRole("region", SMARTER_DIFF.router);
        await router.scrollIntoView();
        await expect
          .poll(
            async () => (await scopesOf(fixtures, SMARTER_DIFF.router)).map((scope) => scope.text),
            {
              timeout: 60_000,
            },
          )
          .toEqual([
            `${SMARTER_DIFF.routerScope[0]} › … › ${SMARTER_DIFF.routerScope[2]} › ${SMARTER_DIFF.routerScope[3]}`,
          ]);
        const [scoped] = await scopesOf(fixtures, SMARTER_DIFF.router);
        expect(scoped?.height).toBe(24);
        for (const opener of SMARTER_DIFF.routerScope) expect(scoped?.title).toContain(opener);
        await screenshotLightAndDark(app, browser, "files-scope");

        // Expanding the lines above shows the inner openers, so the row keeps only the rest.
        await browser.locator(`[data-path="${SMARTER_DIFF.router}"] [data-scope]`).tap();
        await expect
          .poll(
            async () => (await scopesOf(fixtures, SMARTER_DIFF.router)).map((scope) => scope.text),
            {
              timeout: 15_000,
            },
          )
          .not.toContain(
            `${SMARTER_DIFF.routerScope[0]} › … › ${SMARTER_DIFF.routerScope[2]} › ${SMARTER_DIFF.routerScope[3]}`,
          );
        await app.screenshot("files-scope-expanded");

        await screen.getByRole("button", "Split").tap();
        await expect(urls.getByRole("button", MOVED_FROM_LINKS)).toBeVisible();
        await urls.scrollIntoView();
        await screenshotLightAndDark(app, browser, "files-moved-split");
        // Split reads new lines from its right column and writes the scope in its left one.
        await router.scrollIntoView();
        await expect
          .poll(async () => (await scopesOf(fixtures, SMARTER_DIFF.router)).length, {
            timeout: 15_000,
          })
          .toBe(1);
        await app.screenshot("files-scope-split");
        await screen.getByRole("button", "Unified").tap();
        await browser.setViewport({ width: 800, height: 800 });
        await urls.scrollIntoView();
        await app.screenshot("files-moved-narrow");
        await browser.setViewport({ width: 1280, height: 800 });

        // The guide: the landed body in one chapter, the cut in another the reader closed.
        claude.chapters([
          { title: "URLs get a module of their own", files: [SMARTER_DIFF.urls] },
          {
            title: "The rest of the refactor",
            files: [SMARTER_DIFF.links, SMARTER_DIFF.report, SMARTER_DIFF.router],
          },
        ]);
        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
        await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
        const rest = browser.locator(
          '[data-chapter-id="the-rest-of-the-refactor"] [data-chapter-toggle]',
        );
        await expect(rest).toBeVisible({ timeout: 120_000 });
        await rest.scrollIntoView();
        await rest.tap();
        await expect(rest).toHaveAttribute("aria-expanded", "false");
        const chapterUrls = screen.getByRole("region", SMARTER_DIFF.urls);
        await chapterUrls.scrollIntoView();
        await chapterUrls.getByRole("button", MOVED_FROM_LINKS).tap({ timeout: 30_000 });
        await expect(rest).toHaveAttribute("aria-expanded", "true");
        await expect
          .poll(
            async () => {
              const cut = await rowOf(fixtures, SMARTER_DIFF.links, "old", SMARTER_DIFF.cutAt);
              return cut?.selected === true && inView(cut);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        await screenshotLightAndDark(app, browser, "guide-jumped-to-cut");
        await screen.getByRole("region", SMARTER_DIFF.router).scrollIntoView();
        await expect
          .poll(async () => (await scopesOf(fixtures, SMARTER_DIFF.router)).length, {
            timeout: 30_000,
          })
          .toBe(1);
        await screenshotLightAndDark(app, browser, "guide-scope");

        // A fix that moves `describeLink` into the report and changes a line deep in `handle`.
        claude.edits(FIX_EDITS);
        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
        await screen.getByRole("region", SMARTER_DIFF.router).scrollIntoView();
        await draftOn(
          fixtures,
          SMARTER_DIFF.routerChange,
          "Say why private is enough.",
          SMARTER_DIFF.router,
        );
        const dialog = await openSendToAgent(fixtures, 1);
        await pickModel(fixtures, dialog, "sonnet", /Claude Sonnet/);
        await dialog.getByRole("button", "Send 1 comment to agent").tap();
        await fixesTab(fixtures).tap();
        const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
        await expect(ready).toBeVisible({ timeout: TURN_WAIT });
        const fixedReport = ready.getByRole("region", SMARTER_DIFF.report);
        await fixedReport.scrollIntoView();
        await expect(
          fixedReport.getByRole("button", /^Show src\/links\.js lines \d+-\d+$/),
        ).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          ready
            .getByRole("region", SMARTER_DIFF.links)
            .getByRole("button", /^Show src\/report\.js lines \d+-\d+$/),
        ).toBeVisible();
        await ready.getByRole("region", SMARTER_DIFF.router).scrollIntoView();
        await expect
          .poll(
            async () => (await scopesOf(fixtures, SMARTER_DIFF.router)).map((scope) => scope.text),
            {
              timeout: 30_000,
            },
          )
          .toEqual([`${SMARTER_DIFF.routerScope[0]} › ${SMARTER_DIFF.routerScope[1]}`]);
        await screenshotLightAndDark(app, browser, "fixes-moved-and-scope");
      } finally {
        stopFakeInstance("smarter-diff", { keepHome: false });
        closeSmarterDiffFixture(fixture);
      }
    },
  );
});
