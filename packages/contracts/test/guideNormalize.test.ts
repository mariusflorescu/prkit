import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { type DiffFile, DiffSnapshot } from "../src/diffSnapshot.ts";
import { Guide, NormalizedGuide } from "../src/guide.ts";
import type { SkippedFile } from "../src/guideConfig.ts";
import {
  coverageProblems,
  type GuideCheckContext,
  mergeDraft,
  normalizeDraft,
  normalizeGuide,
  patchGuide,
  SKIPPED_CHAPTER_ID,
  withoutUnwrittenChapters,
  withSkippedChapter,
} from "../src/guideNormalize.ts";
import ghStackBehaviorGuide from "./fixtures/github-gh-stack-91/behavior.json" with { type: "json" };
import ghStackGuide from "./fixtures/github-gh-stack-91/guide.json" with { type: "json" };
import ghStackSnapshot from "./fixtures/github-gh-stack-91/snapshot.json" with { type: "json" };
import t3GroupingGuide from "./fixtures/pingdotgg-t3code-16353/guide.json" with { type: "json" };
import t3GroupingSnapshot from "./fixtures/pingdotgg-t3code-16353/snapshot.json" with { type: "json" };
import t3LinksGuide from "./fixtures/pingdotgg-t3code-16782/guide.json" with { type: "json" };
import t3LinksSnapshot from "./fixtures/pingdotgg-t3code-16782/snapshot.json" with { type: "json" };
import aiGuide from "./fixtures/vercel-ai-22182/guide.json" with { type: "json" };
import aiSnapshot from "./fixtures/vercel-ai-22182/snapshot.json" with { type: "json" };
import aiStored from "./fixtures/vercel-ai-22182/stored.json" with { type: "json" };

const textFile: DiffFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: 19,
  deletions: 1,
  patch: { _tag: "text", patch: "@@ -1 +40,19 @@\n-old\n+new" },
};
const snapshot: DiffSnapshot = { files: [textFile] };

const linksFile: DiffFile = {
  path: "src/links.js",
  previousPath: null,
  status: "modified",
  additions: 4,
  deletions: 1,
  patch: {
    _tag: "text",
    patch: [
      "@@ -3,4 +3,6 @@",
      " const links = new Map();",
      "-links.set(code, target);",
      "+validateUrl(target);",
      "+links.set(code, target);",
      "+clicks.set(code, 0);",
      " export const resolve = (code) => links.get(code);",
      " export const count = () => links.size;",
      "@@ -20,2 +22,3 @@",
      " export const reset = () => links.clear();",
      "+export const clicks = new Map();",
      " export default links;",
    ].join("\n"),
  },
};
const logoFile: DiffFile = {
  path: "assets/logo.png",
  previousPath: null,
  status: "added",
  additions: 0,
  deletions: 0,
  patch: { _tag: "binary" },
};
const legacyFile: DiffFile = {
  path: "src/legacy.js",
  previousPath: null,
  status: "removed",
  additions: 0,
  deletions: 2,
  patch: {
    _tag: "text",
    patch: "@@ -1,2 +0,0 @@\n-export const store = new Map();\n-export default store;",
  },
};
const flowSnapshot: DiffSnapshot = { files: [linksFile, logoFile, legacyFile] };
const flowGuide = (flow: object) => ({
  summary: "The change.",
  chapters: [
    {
      id: "core",
      title: "Core",
      kind: "core",
      files: ["src/links.js", "assets/logo.png", "src/legacy.js"],
    },
  ],
  flow,
});
const added = {
  text: "`validateUrl(target)` rejects unsafe links",
  status: "added",
  at: { path: "src/links.js", line: 4 },
  chapter: "core",
} as const;
const removed = {
  text: "any string was stored as the target",
  status: "removed",
  at: { path: "src/links.js", line: 4 },
  chapter: "core",
} as const;
const context = { text: "`GET /<code>`", at: { path: "src/links.js", line: 7 } } as const;

describe("public visualize-pr guides", () => {
  it.each([
    {
      name: "pingdotgg-t3code-16353",
      guide: t3GroupingGuide,
      snapshot: t3GroupingSnapshot,
      flow: "graph",
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
      flow: "graph",
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
      flow: "graph",
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
      flow: "graph",
      chapters: ["init-flow", "docs", "tests"],
    },
    {
      name: "github-gh-stack-91 as a behavior diff",
      guide: ghStackBehaviorGuide,
      snapshot: ghStackSnapshot,
      flow: "behavior",
      chapters: ["init-flow", "docs", "tests"],
    },
  ])("normalizes $name", (fixture) => {
    const guide = Schema.decodeUnknownSync(Guide)(fixture.guide);
    const diff = Schema.decodeUnknownSync(DiffSnapshot)(fixture.snapshot);
    const result = normalizeGuide(guide, diff);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.normalized?.flow?._tag).toBe(fixture.flow);
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
    {
      name: "a flow with both a graph and rows",
      guide: flowGuide({ title: "Change", nodes: [{ id: "a" }], edges: [], rows: [added] }),
      snapshot: flowSnapshot,
      errors: [
        "`flow` has both a graph (`nodes`/`edges`) and a behavior diff (`rows`). Pick the one form that shows this change best and send `flow` again with only that form.",
      ],
    },
    {
      name: "a flow with neither a graph nor rows",
      guide: flowGuide({ title: "Change" }),
      snapshot: flowSnapshot,
      errors: [
        "`flow` needs a graph (`nodes` and `edges`) or a behavior diff (`rows`). Send one, or if neither helps, call submit_guide again with the whole guide and no `flow`.",
      ],
    },
    {
      name: "a graph past 12 nodes",
      guide: flowGuide({
        title: "Change",
        nodes: Array.from({ length: 13 }, (_, index) => ({ id: `n${index}` })),
        edges: [],
      }),
      snapshot: flowSnapshot,
      errors: [
        "`flow` has 13 nodes - past 12 it stops being readable. Keep the main path (4-10 nodes), or send a behavior diff (`rows`) instead.",
      ],
    },
    {
      name: "a behavior diff with no rows",
      guide: flowGuide({ title: "Change", rows: [] }),
      snapshot: flowSnapshot,
      errors: ["`flow.rows` is empty. Send 4-12 rows, or a graph instead."],
    },
    {
      name: "a behavior diff past 16 rows",
      guide: flowGuide({ title: "Change", rows: Array.from({ length: 17 }, () => added) }),
      snapshot: flowSnapshot,
      errors: [
        "`flow` has 17 rows - past 16 it stops being a quick read. Keep the path the PR changes (4-12 rows) and leave the details to the chapters.",
      ],
    },
    {
      name: "a behavior diff that changes nothing",
      guide: flowGuide({ title: "Change", rows: [context, context] }),
      snapshot: flowSnapshot,
      errors: [
        "`flow.rows` has no `added` or `removed` row, so it shows no change. Mark the rows this PR adds or removes.",
      ],
    },
    {
      name: "rows nested wrongly",
      guide: flowGuide({
        title: "Change",
        rows: [{ ...added, depth: 1 }, { ...added, depth: 3 }, { ...added, depth: 4 }, context],
      }),
      snapshot: flowSnapshot,
      errors: [
        "flow row 1: `depth` 1 has no row above it. The first row is at depth 0.",
        "flow row 2: `depth` 3 follows a row at depth 1. A row goes at most one level deeper than the row above it.",
        "flow row 3: `depth` 4 must be 0-3. Flatten the tree: four levels is the most that stays readable.",
      ],
    },
    {
      name: "an added row without a chapter",
      guide: flowGuide({
        title: "Change",
        rows: [{ text: added.text, status: "added", at: added.at }],
      }),
      snapshot: flowSnapshot,
      errors: [
        "flow row 1 is added but has no `chapter`. Set it to the chapter that explains it, by id or 1-based number.",
      ],
    },
    {
      name: "a row chapter that does not exist",
      guide: flowGuide({ title: "Change", rows: [{ ...added, chapter: "missing" }] }),
      snapshot: flowSnapshot,
      errors: ["flow row 1: chapter `missing` doesn't exist. Chapter ids: core."],
    },
    {
      name: "a row in a file outside the PR",
      guide: flowGuide({
        title: "Change",
        rows: [{ ...added, at: { path: "links.js", line: 4 } }],
      }),
      snapshot: flowSnapshot,
      errors: ["flow row 1: `links.js` is not a file in this PR. Did you mean 'src/links.js'?"],
    },
    {
      name: "a row in a binary file",
      guide: flowGuide({
        title: "Change",
        rows: [{ ...added, at: { path: "assets/logo.png", line: 1 } }],
      }),
      snapshot: flowSnapshot,
      errors: [
        "flow row 1: `assets/logo.png` has a `binary` patch, so `at` can't point into it. Point at a line of a text diff.",
      ],
    },
    {
      name: "a row in a deleted file",
      guide: flowGuide({
        title: "Change",
        rows: [{ ...removed, at: { path: "src/legacy.js", line: 1 } }],
      }),
      snapshot: flowSnapshot,
      errors: [
        "flow row 1: `src/legacy.js` is deleted, so it has no new-side lines. Point it at a file that still exists, such as the code that used to call it.",
      ],
    },
    {
      name: "rows outside the hunks",
      guide: flowGuide({
        title: "Change",
        rows: [
          { ...context, at: { path: "src/links.js", line: 12 } },
          { ...removed, at: { path: "src/links.js", line: 12 } },
          { ...added, at: { path: "src/links.js", line: 12 } },
        ],
      }),
      snapshot: flowSnapshot,
      errors: [
        "flow row 1: `src/links.js` line 12 is not a new-side line inside the diff hunks, so it can't open. New-side lines: 3-8, 22-24. A context row points at a line of its code the diff shows; leave the row out if the diff doesn't show it.",
        "flow row 2: `src/links.js` line 12 is not a new-side line inside the diff hunks, so it can't open. New-side lines: 3-8, 22-24. A removed row points at the new-side line next to its `-` lines.",
        "flow row 3: `src/links.js` line 12 is not a new-side line inside the diff hunks, so it can't open. New-side lines: 3-8, 22-24.",
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
    signals: null,
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
      name: "a row in a file the ignore rules skip",
      guide: {
        ...answered,
        flow: {
          title: "Change",
          rows: [
            {
              text: "`run()` is tested",
              status: "added",
              at: { path: "test/a.test.ts", line: 1 },
              chapter: "core",
            },
          ],
        },
      },
      errors: [
        "flow row 1: `test/a.test.ts` is skipped by the reviewer's ignore rules (`test/` (Global)). Point it at a reviewed file.",
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
      risk: null,
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

  it("switches a rejected graph to a behavior diff when the patch sends rows", () => {
    const tooBig: Guide = {
      summary: ["Validates links."],
      chapters: [
        { id: "validate", title: "Reject unsafe links", files: ["src/a.ts", "src/server.js"] },
      ],
      flow: {
        title: "Links",
        nodes: Array.from({ length: 13 }, (_, index) => ({ id: `n${index}` })),
        edges: [],
      },
    };
    expect(normalizeGuide(tooBig, twoFiles).errors).toHaveLength(1);
    const revised = patchGuide(tooBig, {
      flow: {
        title: "Links",
        rows: [
          {
            text: "`validateUrl(url)`",
            status: "added",
            at: { path: "src/a.ts", line: 40 },
            chapter: 1,
          },
        ],
      },
    });
    const result = normalizeGuide(revised, twoFiles);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.flow).toEqual({
      _tag: "behavior",
      title: "Links",
      subtitle: null,
      rows: [
        {
          status: "added",
          text: "`validateUrl(url)`",
          depth: 0,
          at: { path: "src/a.ts", line: 40 },
          chapter: "validate",
        },
      ],
    });
  });
});

describe("the before/after in a streamed draft and in stored revisions", () => {
  const core = { id: "core", title: "Core", body: "Checks links.", files: ["src/links.js"] };
  const rows = [context, added, { ...removed, depth: 1, at: { path: "src/links.js", line: 5 } }];
  const draftFlow = (draft: Parameters<typeof withoutUnwrittenChapters>[0]) =>
    normalizeDraft(withoutUnwrittenChapters(draft), flowSnapshot);
  const rowChapters = (result: ReturnType<typeof draftFlow>) => {
    const flow = result.normalized?.flow;
    return flow?._tag === "behavior" ? flow.rows.map((row) => row.chapter) : [];
  };

  it("shows rows before their chapters exist, links them once they land, and lets a graph replace them", () => {
    const early = mergeDraft({ summary: "The change." }, { flow: { title: "Links", rows } });
    const unwritten = draftFlow(early);
    expect(unwritten.errors).toEqual([]);
    expect(rowChapters(unwritten)).toEqual([null, null, null]);

    const written = draftFlow(mergeDraft(early, { chapters: [core] }));
    expect(written.errors).toEqual([]);
    expect(rowChapters(written)).toEqual([null, "core", "core"]);

    const graph = draftFlow(
      mergeDraft(early, { flow: { title: "Links", nodes: [{ id: "a" }], edges: [] } }),
    );
    expect(graph.errors).toEqual([]);
    expect(graph.normalized?.flow?._tag).toBe("graph");
  });

  it("reads a revision stored before behavior diffs as the graph a fresh guide gets", () => {
    const stored = Schema.decodeUnknownSync(NormalizedGuide)(aiStored);
    const fresh = normalizeGuide(
      Schema.decodeUnknownSync(Guide)(aiGuide),
      Schema.decodeUnknownSync(DiffSnapshot)(aiSnapshot),
    );
    expect(stored.flow?._tag).toBe("graph");
    expect(stored).toEqual(fresh.normalized);
  });
});
