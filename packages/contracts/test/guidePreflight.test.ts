import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { DiffSnapshot } from "../src/diffSnapshot.ts";
import { Guide, NormalizedGuide } from "../src/guide.ts";
import { type GuideCheckContext, normalizeGuide } from "../src/guideNormalize.ts";

const snapshot: DiffSnapshot = {
  files: [
    {
      path: "src/limits.ts",
      previousPath: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: {
        _tag: "text",
        patch:
          "@@ -1,3 +1,4 @@\n export const limits = {\n-  url: 1024,\n+  url: 2048,\n+  slug: 64,\n };",
      },
    },
    {
      path: "test/limits.test.ts",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: { _tag: "text", patch: "@@ -2 +2 @@\n-assert(1024)\n+assert(2048)" },
    },
    {
      path: "src/old.ts",
      previousPath: null,
      status: "removed",
      additions: 0,
      deletions: 1,
      patch: { _tag: "text", patch: "@@ -1 +0,0 @@\n-export {};" },
    },
    {
      path: "tsconfig.json",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: { _tag: "text", patch: '@@ -1 +1 @@\n-{"strict": false}\n+{"strict": true}' },
    },
    {
      path: "src/slug.ts",
      previousPath: "src/slugs.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      patch: { _tag: "text", patch: "" },
    },
  ],
};
const DESCRIPTION = "Raises the URL limit to 2048.\n\nAlso trims  whitespace from slugs.";
const own: GuideCheckContext = {
  focusAreas: [],
  skipped: [],
  signals: null,
  preflight: { description: DESCRIPTION },
};
const others: GuideCheckContext = { ...own, preflight: null };
const base = {
  summary: "Raises the limits.",
  chapters: [
    {
      id: "limits",
      title: "Limits grow",
      kind: "core",
      files: ["src/limits.ts", "src/old.ts", "src/slug.ts", "tsconfig.json"],
    },
    { id: "tests", title: "Tests follow", kind: "tests", files: ["test/limits.test.ts"] },
  ],
  flow: { title: "Limits", nodes: [{ id: "limits", status: "changed" }], edges: [] },
};
const check = (preflight: object | undefined, context: GuideCheckContext = own) =>
  normalizeGuide(
    Schema.decodeUnknownSync(Guide)(preflight === undefined ? base : { ...base, preflight }),
    snapshot,
    context,
  );

describe("the author's pre-flight", () => {
  it("is required on the author's own pull request, and an empty one means nothing to flag", () => {
    expect(check(undefined).errors).toEqual([
      expect.stringContaining("the guide needs `preflight`"),
    ]);
    expect(check({}).normalized?.preflight).toEqual({ questions: [], description: [], tests: [] });
  });

  it("is refused on someone else's pull request, and older revisions read as having none", () => {
    expect(check({}, others).errors).toEqual([
      expect.stringContaining("only for the author's own pull request"),
    ]);
    const stored = check(undefined, others).normalized;
    if (stored === null) throw new Error("The guide without a pre-flight was refused.");
    const { preflight: _, ...older } = Schema.encodeSync(NormalizedGuide)(stored);
    expect(Schema.decodeUnknownSync(NormalizedGuide)(older).preflight).toBeNull();
  });

  it("takes a quote only in the description's own words, whatever its case and spacing", () => {
    const claims = (quote: string) =>
      check({ description: [{ kind: "missing-from-code", text: "Nothing trims slugs.", quote }] });
    expect(claims("also trims whitespace\nfrom slugs").normalized?.preflight?.description).toEqual([
      {
        kind: "missing-from-code",
        text: "Nothing trims slugs.",
        quote: "also trims whitespace\nfrom slugs",
      },
    ]);
    expect(claims("Handles empty input").errors).toEqual([
      expect.stringContaining("is not in the description"),
    ]);
  });

  it("keeps every claim's evidence to its kind", () => {
    const { errors } = check({
      description: [
        { kind: "missing-from-description", text: "Slugs are capped too.", chapter: "" },
        { kind: "missing-from-code", text: "Nothing trims.", quote: "trims", chapter: "limits" },
        { kind: "differs", text: "It says 2048.", chapter: "limits" },
      ],
    });
    expect(errors).toEqual([
      expect.stringContaining("preflight description 1 points at nothing"),
      expect.stringContaining("leave `chapter` and `at` out"),
      expect.stringContaining("preflight description 3 has no `quote`"),
    ]);
  });

  it("gives a question about one line its file's chapter, and refuses a line outside the hunks", () => {
    const asked = (line: number) =>
      check({
        questions: [{ text: "Why 64?", at: { path: "src/limits.ts", line } }],
      });
    expect(asked(3).normalized?.preflight?.questions).toEqual([
      { text: "Why 64?", chapter: "limits", at: { path: "src/limits.ts", line: 3 } },
    ]);
    expect(asked(9).errors).toEqual([expect.stringContaining("line 9 is not a new-side line")]);
    expect(
      check({
        questions: [{ text: "Why?", chapter: "tests", at: { path: "src/limits.ts", line: 3 } }],
      }).errors,
    ).toEqual([expect.stringContaining("is in chapter `limits`, not `tests`")]);
  });

  it("points a missing test at changed source code, never a test, config, rename or deleted file", () => {
    const { errors } = check({
      tests: [
        { text: "Nothing tests slugs.", path: "src/limits.ts", line: 3 },
        { text: "The test is thin.", path: "test/limits.test.ts" },
        { text: "Old code.", path: "src/old.ts" },
        { text: "Strict mode.", path: "tsconfig.json" },
        { text: "Moved.", path: "src/slug.ts" },
        { text: "Nothing tests this.", path: "src/limits.ts" },
      ],
    });
    expect(errors).toEqual([
      expect.stringContaining("`preflight.tests` has 6 items. Keep the 4"),
      expect.stringContaining("`src/limits.ts` is already listed"),
      expect.stringContaining("`test/limits.test.ts` isn't changed source code"),
      expect.stringContaining("`src/old.ts` is deleted"),
      expect.stringContaining("`tsconfig.json` isn't changed source code"),
      expect.stringContaining("`src/slug.ts` isn't changed source code"),
    ]);
  });

  it("compares nothing when the pull request has no description", () => {
    const { errors } = check(
      { description: [{ kind: "missing-from-description", text: "Slugs.", chapter: "limits" }] },
      { ...own, preflight: { description: "" } },
    );
    expect(errors).toEqual([expect.stringContaining("has no description")]);
  });
});
