import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { type DiffFile, DiffSnapshot } from "../src/diffSnapshot.ts";
import { Guide, NormalizedGuide } from "../src/guide.ts";
import type { SkippedFile } from "../src/guideConfig.ts";
import {
  coverageProblems,
  type GuideCheckContext,
  normalizeGuide,
  patchGuide,
  SKIPPED_CHAPTER_ID,
  withSkippedChapter,
} from "../src/guideNormalize.ts";
import ghStackGuide from "./fixtures/github-gh-stack-91/guide.json" with { type: "json" };
import ghStackSnapshot from "./fixtures/github-gh-stack-91/snapshot.json" with { type: "json" };
import t3GroupingGuide from "./fixtures/pingdotgg-t3code-16353/guide.json" with { type: "json" };
import t3GroupingSnapshot from "./fixtures/pingdotgg-t3code-16353/snapshot.json" with { type: "json" };
import t3LinksGuide from "./fixtures/pingdotgg-t3code-16782/guide.json" with { type: "json" };
import t3LinksSnapshot from "./fixtures/pingdotgg-t3code-16782/snapshot.json" with { type: "json" };
import aiGuide from "./fixtures/vercel-ai-22182/guide.json" with { type: "json" };
import aiSnapshot from "./fixtures/vercel-ai-22182/snapshot.json" with { type: "json" };

const textFile: DiffFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: 19,
  deletions: 1,
  patch: { _tag: "text", patch: "@@ -1 +40,19 @@\n-old\n+new" },
};
const snapshot: DiffSnapshot = { files: [textFile] };

describe("public visualize-pr guides", () => {
  it.each([
    {
      name: "pingdotgg-t3code-16353",
      guide: t3GroupingGuide,
      snapshot: t3GroupingSnapshot,
      chapters: [
        "identity-origin",
        "resolver-origin",
        "client-grouping",
        "mobile-matching",
        "tests",
        "docs",
      ],
    },
    {
      name: "pingdotgg-t3code-16782",
      guide: t3LinksGuide,
      snapshot: t3LinksSnapshot,
      chapters: [
        "thread-links",
        "snooze-rule",
        "thread-tools",
        "web-links",
        "mobile-links",
        "tests",
        "docs",
      ],
    },
    {
      name: "vercel-ai-22182",
      guide: aiGuide,
      snapshot: aiSnapshot,
      chapters: [
        "codes",
        "dedupe",
        "deprecated-apis",
        "example",
        "bundle",
        "new-tests",
        "test-expectations",
        "docs",
      ],
    },
    {
      name: "github-gh-stack-91",
      guide: ghStackGuide,
      snapshot: ghStackSnapshot,
      chapters: ["init-flow", "docs", "tests"],
    },
  ])("normalizes $name", (fixture) => {
    const guide = Schema.decodeUnknownSync(Guide)(fixture.guide);
    const diff = Schema.decodeUnknownSync(DiffSnapshot)(fixture.snapshot);
    const result = normalizeGuide(guide, diff);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.chapters.map((chapter) => chapter.id)).toEqual(fixture.chapters);
    expect(result.normalized?.chapters.flatMap((chapter) => chapter.files).length).toBe(
      diff.files.length,
    );
    expect(Schema.is(NormalizedGuide)(result.normalized)).toBe(true);
  });
});

describe("agent correction messages", () => {
  it.each([
    {
      name: "a file missing from every chapter",
      guide: { summary: "The change.", chapters: [{ title: "Core", files: ["src/a.ts"] }] },
      snapshot: { files: [textFile, { ...textFile, path: "src/b.ts" }] },
      errors: [
        '1 file(s) are not in any chapter. Put each one where it fits, or add a glob like `"**/*.test.ts"` to a tests chapter:\n    src/b.ts',
      ],
    },
    {
      name: "a file in two chapters",
      guide: {
        summary: "The change.",
        chapters: [
          { title: "Core", files: ["src/a.ts"] },
          { title: "Other", files: ["src/a.ts"] },
        ],
      },
      snapshot,
      errors: [
        "`src/a.ts` is in both `core` and `other` - each file belongs to exactly one chapter.",
        "chapter `other` ended up with no files.",
      ],
    },
    {
      name: "an unknown chapter in flow and focus",
      guide: {
        summary: "The change.",
        chapters: [{ title: "Core", files: ["src/a.ts"] }],
        flow: { title: "Change", nodes: [{ id: "a", chapter: "missing" }], edges: [] },
        focus: [{ text: "Read this.", chapter: "missing" }],
      },
      snapshot,
      errors: [
        "focus item: chapter `missing` doesn't exist. Chapter ids: core.",
        "flow node `a`: chapter `missing` doesn't exist. Chapter ids: core.",
      ],
    },
    {
      name: "an annotation outside the hunks",
      guide: {
        summary: "The change.",
        chapters: [
          {
            title: "Core",
            files: [{ path: "src/a.ts", annotations: [{ line: 12, text: "Read this." }] }],
          },
        ],
      },
      snapshot,
      errors: [
        "`src/a.ts`: additions line 12 is outside the diff hunks, so the note would be hidden. Visible additions lines: 40-58.",
      ],
    },
    {
      name: "an annotation on a binary file",
      guide: {
        summary: "The change.",
        chapters: [
          {
            title: "Core",
            files: [{ path: "src/a.ts", annotations: [{ line: 40, text: "Read this." }] }],
          },
        ],
      },
      snapshot: { files: [{ ...textFile, patch: { _tag: "binary" } }] },
      errors: [
        "`src/a.ts`: additions line 40 cannot have a note because the patch is `binary`. Line notes need a text patch with diff hunks.",
      ],
    },
    {
      name: "an annotation on a rename-only file",
      guide: {
        summary: "The change.",
        chapters: [
          {
            title: "Core",
            files: [{ path: "src/a.ts", annotations: [{ line: 40, text: "Read this." }] }],
          },
        ],
      },
      snapshot: {
        files: [
          {
            ...textFile,
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
            patch: { _tag: "text", patch: "" },
          },
        ],
      },
      errors: [
        "`src/a.ts`: additions line 40 cannot have a note because the text patch has no diff hunks. Rename-only files cannot have line notes.",
      ],
    },
  ])("rejects $name", (fixture) => {
    const guide = Schema.decodeUnknownSync(Guide)(fixture.guide);
    const diff = Schema.decodeUnknownSync(DiffSnapshot)(fixture.snapshot);
    const result = normalizeGuide(guide, diff);
    expect(result.errors).toEqual(fixture.errors);
    expect(result.normalized).toBeNull();
  });
});

describe("checks that depend on the attempt's settings", () => {
  const testFile: DiffFile = { ...textFile, path: "test/a.test.ts", additions: 11, deletions: 0 };
  const skippedTest: SkippedFile = {
    path: "test/a.test.ts",
    previousPath: null,
    additions: 11,
    deletions: 0,
    reasons: [{ path: "test/a.test.ts", pattern: "test/", scope: "global" }],
  };
  const context: GuideCheckContext = {
    focusAreas: [
      { handle: "security", label: "Security", question: "Is any input trusted without checks?" },
    ],
    skipped: [skippedTest],
  };
  const check = (guide: object, withContext: GuideCheckContext | null = context) =>
    normalizeGuide(Schema.decodeUnknownSync(Guide)(guide), snapshot, withContext);
  const answered = {
    summary: "The change.",
    chapters: [{ id: "core", title: "Core", kind: "core", files: ["src/a.ts"] }],
    flow: { title: "Change", nodes: [{ id: "a" }], edges: [] },
    focusAreas: [
      {
        id: "security",
        verdict: "notable",
        text: "The URL reaches the store unchecked.",
        chapter: "core",
      },
    ],
    guidanceNote: "The PR asked for depth on validation, which wins over Global's short chapters.",
  };

  it("accepts one answer per focus area and keeps the reviewer's label and question", () => {
    const result = check(answered);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.focusAreas).toEqual([
      {
        id: "security",
        label: "Security",
        question: "Is any input trusted without checks?",
        verdict: "notable",
        text: "The URL reaches the store unchecked.",
        chapter: "core",
      },
    ]);
    expect(result.normalized?.guidanceNote).toBe(answered.guidanceNote);
  });

  it.each([
    {
      name: "a missing focus area",
      guide: { ...answered, focusAreas: [] },
      errors: [
        '`focusAreas` has no entry for `security` (Security: Is any input trusted without checks?). Add {"id": "security", "verdict": "notable" | "nothing-notable" | "not-assessed", "text": "...", "chapter": "<chapter id when notable>"}.',
      ],
    },
    {
      name: "a notable verdict without a chapter",
      guide: {
        ...answered,
        focusAreas: [{ id: "security", verdict: "notable", text: "Unchecked URL." }],
      },
      errors: [
        "focus area `security` is notable, so set `chapter` to the chapter that explains what the reviewer should look at.",
      ],
    },
    {
      name: "an unassessed area without a reason, and one nobody asked for",
      guide: {
        ...answered,
        focusAreas: [
          { id: "security", verdict: "not-assessed" },
          { id: "speed", verdict: "nothing-notable" },
        ],
      },
      errors: [
        'focus area `security` is not assessed but has no `text`. Say why, for example "docs-only PR, no migrations touched".',
        "focus area `speed` isn't one of the reviewer's focus areas. Their ids: security.",
      ],
    },
    {
      name: "a skipped file and prkit's own chapter id",
      guide: {
        ...answered,
        chapters: [
          { id: "core", title: "Core", kind: "core", files: ["src/a.ts"] },
          { id: SKIPPED_CHAPTER_ID, title: "Tests", files: ["test/a.test.ts"] },
        ],
      },
      errors: [
        "chapter 2 ('Tests'): id `skipped-by-your-ignore-rules` is prkit's own chapter for skipped files. Give your chapter another `id`.",
        "chapter `skipped-by-your-ignore-rules`: `test/a.test.ts` is skipped by the reviewer's ignore rules (`test/` (Global)). Leave it out; prkit lists skipped files in a chapter of its own.",
        "chapter `skipped-by-your-ignore-rules` ended up with no files.",
      ],
    },
  ])("rejects $name", (fixture) => {
    const result = check(fixture.guide);
    expect(result.errors).toEqual(fixture.errors);
    expect(result.normalized).toBeNull();
  });

  it("appends the skipped files as prkit's last chapter, covering the full diff exactly once", () => {
    const accepted = check(answered).normalized;
    expect(accepted).not.toBeNull();
    if (accepted === null) return;
    const full = withSkippedChapter(accepted, [skippedTest]);
    expect(full.chapters.at(-1)).toEqual({
      id: SKIPPED_CHAPTER_ID,
      title: "Skipped by your ignore rules",
      kind: "generated",
      body: [
        "prkit left 1 file out of the guide because your ignore rules skip it. The agent didn't review it; the diffs are here if you want to look.",
      ],
      pseudocode: null,
      callouts: [],
      files: [
        {
          path: "test/a.test.ts",
          note: "+11 -0 · skipped by `test/` (Global)",
          collapsed: true,
          annotations: [],
        },
      ],
    });
    expect(coverageProblems(full, { files: [textFile, testFile] })).toEqual([]);
    expect(coverageProblems(accepted, { files: [textFile, testFile] })).toEqual([
      "`test/a.test.ts` is not in any chapter.",
    ]);
    expect(withSkippedChapter(accepted, [])).toBe(accepted);
  });

  it("checks a guide without settings as the visualize-pr format alone", () => {
    const { focusAreas: _areas, guidanceNote: _note, ...plain } = answered;
    const result = check(plain, null);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.focusAreas).toEqual([]);
    expect(result.normalized?.guidanceNote).toBeNull();
  });

  it("reads revisions stored before focus areas existed", () => {
    const stored = {
      summary: ["The change."],
      background: [],
      steps: [],
      chapters: [],
      flow: null,
      focus: [],
    };
    const decoded = Schema.decodeUnknownSync(NormalizedGuide)(stored);
    expect(decoded.focusAreas).toEqual([]);
    expect(decoded.guidanceNote).toBeNull();
  });
});

describe("revise_guide", () => {
  const twoFiles: DiffSnapshot = {
    files: [textFile, { ...textFile, path: "src/server.js" }],
  };
  const rejected: Guide = {
    summary: ["Validates links and counts clicks."],
    chapters: [
      { id: "validate", title: "Reject unsafe links", files: ["src/a.ts", "src/server.js"] },
      { id: "clicks", title: "Count clicks", files: ["src/server.js"] },
    ],
  };

  it("replaces the chapter it names, keeps the rest, and the result passes the same checks", () => {
    expect(normalizeGuide(rejected, twoFiles).errors).toEqual([
      "`src/server.js` is in both `validate` and `clicks` - each file belongs to exactly one chapter.",
      "chapter `clicks` ended up with no files.",
    ]);
    const revised = patchGuide(rejected, {
      chapters: [{ id: "validate", title: "Reject unsafe links", files: ["src/a.ts"] }],
    });
    const result = normalizeGuide(revised, twoFiles);
    expect(result.errors).toEqual([]);
    expect(
      result.normalized?.chapters.map((chapter) => [
        chapter.id,
        chapter.files.map((file) => file.path),
      ]),
    ).toEqual([
      ["validate", ["src/a.ts"]],
      ["clicks", ["src/server.js"]],
    ]);
  });

  it("puts a chapter with a new id last and replaces the fields it sends", () => {
    const revised = patchGuide(rejected, {
      summary: ["Rejects unsafe links."],
      chapters: [{ id: "tests", title: "Test the check", files: ["src/a.ts"] }],
    });
    expect(revised.summary).toEqual(["Rejects unsafe links."]);
    expect(revised.chapters.map((chapter) => chapter.id)).toEqual(["validate", "clicks", "tests"]);
  });
});
