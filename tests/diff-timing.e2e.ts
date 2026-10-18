import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { largeDiff } from "./largeDiffFixture.ts";

const FILES = 200;
const METHODS = 12;
/**
 * How long the fake takes to answer GraphQL, the file text reads among it. 0 answers at once,
 * the worst case for the first paint; real GitHub took about two seconds for 50 files.
 */
const GRAPHQL_MS = Number(process.env.DIFF_TIMING_GRAPHQL_MS ?? "0");
/** Where the numbers go; `DIFF_TIMING_LABEL` names the build they came from. */
const EVIDENCE = NodePath.join(import.meta.dirname, "..", ".e2e", "evidence", "diff-timing");

const Marks = Schema.fromJsonString(
  Schema.Struct({
    cards: Schema.NullOr(Schema.Number),
    firstDiff: Schema.NullOr(Schema.Number),
    tenDiffs: Schema.NullOr(Schema.Number),
    longTasks: Schema.Array(Schema.Struct({ start: Schema.Number, duration: Schema.Number })),
  }),
);
const Scrolled = Schema.fromJsonString(
  Schema.Struct({
    scrollMs: Schema.Number,
    since: Schema.Number,
    rendered: Schema.Number,
    scope: Schema.Number,
  }),
);

test(
  "diff timing: a 200-file diff with 1,000 hunks paints, scrolls and stays responsive",
  { timeout: 600_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub("diff-timing");
    try {
      const diff = largeDiff(FILES, METHODS);
      await fake.files(9, diff.files);
      await fake.texts(9, diff.texts);
      const run = startFakeInstance("diff-timing", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      if (GRAPHQL_MS > 0) await fake.latency(GRAPHQL_MS, "graphql");
      await browser.addInitScript(() => {
        const marks = {
          cards: Number.NaN,
          firstDiff: Number.NaN,
          tenDiffs: Number.NaN,
          longTasks: new Array<{ start: number; duration: number }>(),
        };
        Object.assign(window, { prkitDiffTiming: marks });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            marks.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: "longtask", buffered: true });
        const painted = () =>
          [...document.querySelectorAll("[data-file-diff-card] diffs-container")].filter(
            (host) => host.shadowRoot?.querySelector("[data-line]") != null,
          ).length;
        const watch = window.setInterval(() => {
          if (Number.isNaN(marks.cards) && document.querySelector("[data-file-diff-card]"))
            marks.cards = performance.now();
          const count = painted();
          if (Number.isNaN(marks.firstDiff) && count >= 1) marks.firstDiff = performance.now();
          if (Number.isNaN(marks.tenDiffs) && count >= 10) {
            marks.tenDiffs = performance.now();
            window.clearInterval(watch);
          }
        }, 16);
      }, null);
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`,
      );
      const readMarks = async () =>
        Schema.decodeSync(Marks)(
          await browser.evaluate(() =>
            "prkitDiffTiming" in window ? JSON.stringify(window.prkitDiffTiming) : "",
          ),
        );
      await expect
        .poll(async () => (await readMarks()).tenDiffs !== null, { timeout: 60_000, interval: 250 })
        .toBe(true);
      await app.screenshot("large-diff-first-paint");

      const scroll = await browser.evaluate(async () => {
        const started = performance.now();
        const cards = [...document.querySelectorAll<HTMLElement>("[data-file-diff-card]")];
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        for (const card of cards) {
          card.scrollIntoView({ block: "start" });
          await frame();
          await frame();
        }
        const deadline = performance.now() + 30_000;
        const rendered = () =>
          cards.filter(
            (card) =>
              card.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]") !=
              null,
          ).length;
        while (rendered() < cards.length && performance.now() < deadline) await frame();
        const scope = cards.reduce(
          (sum, card) =>
            sum +
            (card.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-scope]")
              .length ?? 0),
          0,
        );
        return JSON.stringify({
          scrollMs: Math.round(performance.now() - started),
          rendered: rendered(),
          scope,
          since: started,
        });
      });
      const marks = await readMarks();
      const scrolled = Schema.decodeSync(Scrolled)(scroll);
      const during = (from: number, to: number) =>
        marks.longTasks.filter((task) => task.start >= from && task.start < to);
      const summary = (tasks: ReadonlyArray<{ duration: number }>) => ({
        count: tasks.length,
        totalMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)),
        maxMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
      });
      const report = {
        label: process.env.DIFF_TIMING_LABEL ?? "unlabelled",
        graphqlMs: GRAPHQL_MS,
        at: new Date().toISOString(),
        loadavg: NodeOS.loadavg().map((load) => Number(load.toFixed(2))),
        files: diff.files.length,
        changedLines: diff.files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
        hunks: diff.files.reduce((sum, file) => sum + (file.patch.match(/^@@/gm)?.length ?? 0), 0),
        cardsMs: Math.round(marks.cards ?? -1),
        firstDiffMs: Math.round(marks.firstDiff ?? -1),
        tenDiffsMs: Math.round(marks.tenDiffs ?? -1),
        longTasksUntilTenDiffs: summary(during(0, marks.tenDiffs ?? 0)),
        scrollMs: scrolled.scrollMs,
        longTasksWhileScrolling: summary(during(scrolled.since, Number.POSITIVE_INFINITY)),
        rendered: scrolled.rendered,
        scopeRows: scrolled.scope,
      };
      NodeFS.mkdirSync(EVIDENCE, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(EVIDENCE, `${report.label}-${report.at.replaceAll(":", "-")}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(JSON.stringify(report));
      expect(report.rendered).toBe(FILES);
      expect(report.tenDiffsMs).toBeGreaterThan(0);
    } finally {
      stopFakeInstance("diff-timing", { keepHome: false });
      fake.stop();
    }
  },
);
