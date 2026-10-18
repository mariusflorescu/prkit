import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { DiffFile } from "../src/diffSnapshot.ts";
import { Guide } from "../src/guide.ts";
import { type GuideCheckContext, normalizeGuide } from "../src/guideNormalize.ts";

const file = (path: string): DiffFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: { _tag: "text", patch: "@@ -1,1 +1,2 @@\n context\n+new" },
});
const snapshot = { files: [file("src/validate.js"), file("src/stats.js")] };
const context: GuideCheckContext = {
  focusAreas: [],
  skipped: [],
  signals: null,
  preflight: null,
  manualCheck: true,
};
const guide = {
  summary: "Validates links and counts clicks.",
  chapters: [
    { id: "validate", title: "Reject unsafe links", files: ["src/validate.js"] },
    { id: "count", title: "Count clicks", files: ["src/stats.js"] },
  ],
};
const shorten = {
  action: "Shorten `https://example.com`, open the short link, then `/stats/<code>`.",
  expect: "The stats page shows 1.",
  watchFor: "A second visit counting twice.",
  chapter: "count",
};
const unsafe = {
  action: "Shorten `javascript:alert(1)`.",
  expect: "A 400, and no new link.",
  chapter: 1,
};
const check = (manualCheck: object | undefined, withContext: GuideCheckContext = context) =>
  normalizeGuide(
    Schema.decodeUnknownSync(Guide)(manualCheck === undefined ? guide : { ...guide, manualCheck }),
    snapshot,
    withContext,
  );

describe("how to check it", () => {
  it("keeps a plan's steps in order with their chapters resolved", () => {
    const result = check({ setup: " Run `npm start`. ", steps: [shorten, unsafe] });
    expect(result.errors).toEqual([]);
    expect(result.normalized?.manualCheck).toEqual({
      _tag: "steps",
      setup: "Run `npm start`.",
      steps: [
        { ...shorten, chapter: "count" },
        { ...unsafe, watchFor: null, chapter: "validate" },
      ],
    });
  });

  it("takes nothing to check by hand with its reason", () => {
    const result = check({ steps: [], reason: "Only renames `parseUrl`." });
    expect(result.errors).toEqual([]);
    expect(result.normalized?.manualCheck).toEqual({
      _tag: "nothing",
      reason: "Only renames `parseUrl`.",
    });
  });

  it("asks for a plan only from an attempt that asked the agent for one", () => {
    expect(check(undefined).errors).toEqual([expect.stringContaining("`manualCheck` is missing.")]);
    const old = check(undefined, { ...context, manualCheck: false });
    expect(old.errors).toEqual([]);
    expect(old.normalized?.manualCheck).toBeNull();
  });

  it("refuses a plan a reader couldn't follow, and says how to fix it", () => {
    const cases: ReadonlyArray<readonly [object, string]> = [
      [{ steps: [shorten, { ...unsafe, chapter: "stats" }] }, "chapter `stats` doesn't exist"],
      [{ steps: [shorten, { ...unsafe, chapter: 3 }] }, "chapter number 3 is out of range"],
      [{ steps: [shorten, { ...unsafe, expect: " " }] }, "step 2 has no `expect`"],
      [{ steps: [shorten, { ...unsafe, action: "" }] }, "step 2 has no `action`"],
      [
        { steps: [shorten, { ...shorten, watchFor: "Other.", chapter: 1 }] },
        "step 2 is the same check as step 1",
      ],
      [{ steps: [unsafe] }, "No `manualCheck` step has a `watchFor`"],
      [
        {
          steps: Array.from({ length: 6 }, (_, index) => ({
            ...shorten,
            action: `Open link ${index + 1}.`,
          })),
        },
        "has 6 steps",
      ],
      [{ steps: [] }, "has no steps and no `reason`"],
      [{ steps: [], reason: "Docs only.", setup: "Run it." }, "only goes with steps"],
      [{ steps: [shorten], reason: "Docs only." }, "has steps and a `reason`"],
    ];
    for (const [manualCheck, problem] of cases) {
      const result = check(manualCheck);
      expect(result.normalized).toBeNull();
      expect(result.errors).toEqual([expect.stringContaining(problem)]);
    }
  });
});
