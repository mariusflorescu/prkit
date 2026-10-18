import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { DiffFile } from "../src/diffSnapshot.ts";
import { DraftGuide, Guide, NormalizedGuide } from "../src/guide.ts";
import type { RiskSignal } from "../src/guideConfig.ts";
import {
  type GuideCheckContext,
  normalizeDraft,
  normalizeGuide,
  SKIPPED_CHAPTER_ID,
  withoutUnwrittenChapters,
} from "../src/guideNormalize.ts";
import aiStored from "./fixtures/vercel-ai-22182/stored.json" with { type: "json" };

/** A file whose hunk shows new-side lines 10-12. */
const file = (path: string): DiffFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: { _tag: "text", patch: "@@ -10,2 +10,3 @@\n context\n-old\n+new\n+more" },
});
const snapshot = { files: [file("src/links.js"), file("src/auth/session.js")] };
const signals: ReadonlyArray<RiskSignal> = [
  {
    _tag: "sensitive",
    files: [{ path: "src/auth/session.js", pattern: "src/auth/", scope: "global" }],
  },
];
const context: GuideCheckContext = {
  focusAreas: [],
  skipped: [
    {
      path: "test/links.test.js",
      previousPath: null,
      additions: 4,
      deletions: 0,
      reasons: [{ path: "test/links.test.js", pattern: "test/", scope: "global" }],
    },
  ],
  signals,
};
const check = (guide: object, withContext: GuideCheckContext = context) =>
  normalizeGuide(Schema.decodeUnknownSync(Guide)(guide), snapshot, withContext);

const linksChapter = {
  id: "links",
  title: "Reject unsafe links",
  kind: "core",
  body: "`addLink` checks the URL before it stores it.",
  files: ["src/links.js"],
  risk: {
    level: "medium",
    reasons: [
      { text: "Every stored link now goes through `validateUrl`.", file: "src/links.js", line: 11 },
    ],
  },
};
const authChapter = {
  id: "auth",
  title: "Check the session",
  body: "Only a signed-in user can add a link.",
  files: ["src/auth/session.js"],
  risk: {
    level: "medium",
    reasons: [{ text: "Reads the session before a link is saved.", file: "src/auth/session.js" }],
  },
};
const rated = {
  summary: "Checks links before storing them.",
  chapters: [linksChapter, authChapter],
  risk: {
    level: "medium",
    reasons: [
      {
        text: "Unsafe links are now rejected before they are stored.",
        chapter: "links",
        at: { path: "src/links.js", line: 11 },
      },
    ],
  },
  flow: { title: "Change", nodes: [{ id: "a" }], edges: [] },
};
const withRisk = (chapter: object, risk: object) => ({ ...chapter, risk });
const { risk: _linksRisk, ...linksUnrated } = linksChapter;
const { risk: _authRisk, ...authUnrated } = authChapter;
const { risk: _risk, ...unrated } = rated;

describe("how carefully to read", () => {
  it("accepts a rated guide, keeps prkit's signals next to it, and stores it as it was checked", () => {
    const result = check(rated);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const accepted = result.normalized;
    expect(accepted).not.toBeNull();
    if (accepted === null) return;
    expect(accepted.risk).toEqual({
      level: "medium",
      reasons: [
        {
          text: "Unsafe links are now rejected before they are stored.",
          chapter: "links",
          at: { path: "src/links.js", line: 11 },
        },
      ],
    });
    expect(accepted.chapters.map((chapter) => chapter.risk)).toEqual([
      {
        level: "medium",
        reasons: [
          {
            text: "Every stored link now goes through `validateUrl`.",
            file: "src/links.js",
            line: 11,
          },
        ],
      },
      {
        level: "medium",
        reasons: [
          {
            text: "Reads the session before a link is saved.",
            file: "src/auth/session.js",
            line: null,
          },
        ],
      },
    ]);
    expect(accepted.signals).toEqual(signals);
    const stored = Schema.encodeSync(Schema.fromJsonString(NormalizedGuide))(accepted);
    expect(Schema.decodeSync(Schema.fromJsonString(NormalizedGuide))(stored)).toEqual(accepted);
  });

  it.each([
    {
      name: "a guide with no risk",
      guide: { ...unrated, chapters: [linksUnrated, authUnrated] },
      errors: [
        'These chapters have no `risk`: `links`, `auth`. Give each one {"level": "low" | "medium" | "high", "reasons": [{"text": "...", "file": "<a file of the chapter>"}]}.',
        '`risk` is missing. Rate how carefully the reviewer should read this pull request: {"level": "low" | "medium" | "high", "reasons": [{"text": "...", "chapter": "<chapter id>"}]}.',
      ],
    },
    {
      name: "reasons without evidence",
      guide: {
        ...rated,
        risk: { level: "medium", reasons: [{ text: "Rejects unsafe links." }] },
        chapters: [
          withRisk(linksChapter, { level: "medium", reasons: [{ text: "Validates links." }] }),
          withRisk(authChapter, { level: "medium" }),
        ],
      },
      errors: [
        "chapter `links` risk reason 1 has no `file`. Set it to the file of this chapter the reason is about: `src/links.js`.",
        "chapter `auth`: `risk` has no reasons. A level always comes with its reasons: say in one sentence what makes it medium, and point at the evidence.",
        "`risk` reason 1 has no `chapter`. Set it to the chapter that explains it, by id or 1-based number.",
      ],
    },
    {
      name: "evidence that doesn't open where the reason says",
      guide: {
        ...rated,
        risk: {
          level: "medium",
          reasons: [
            {
              text: "Rejects unsafe links.",
              chapter: "links",
              at: { path: "src/auth/session.js", line: 11 },
            },
          ],
        },
        chapters: [
          withRisk(linksChapter, {
            level: "medium",
            reasons: [{ text: "Checks the session.", file: "src/auth/session.js" }],
          }),
          withRisk(authChapter, {
            level: "medium",
            reasons: [{ text: "Reads the session.", file: "src/auth/session.js", line: 30 }],
          }),
        ],
      },
      errors: [
        "chapter `links` risk reason 1: `src/auth/session.js` is not a file of this chapter. Its files: `src/links.js`.",
        "chapter `auth` risk reason 1: `src/auth/session.js` line 30 is not a new-side line inside the diff hunks, so it can't open. New-side lines: 10-12.",
        "`risk` reason 1: `at` is in `src/auth/session.js`, which is in chapter `auth`, not `links`. Point at a line of a file in the chapter the reason names.",
      ],
    },
    {
      name: "a pull request rated below a chapter, and a look-closely file rated low",
      guide: {
        ...rated,
        risk: { ...rated.risk, level: "low" },
        chapters: [linksChapter, withRisk(authChapter, { ...authChapter.risk, level: "low" })],
      },
      errors: [
        "chapter `auth` is low, but `src/auth/session.js` matches `src/auth/` (Global), a path the reviewer always looks closely at. Rate the chapter medium or high and say why.",
        "`risk.level` is low, but chapter `links` is medium. The pull request needs at least as careful a read as its most careful chapter: raise `risk.level` or lower the chapter.",
      ],
    },
    {
      name: "a reason naming prkit's chapter for skipped files",
      guide: {
        ...rated,
        risk: {
          level: "medium",
          reasons: [{ text: "The tests are skipped.", chapter: SKIPPED_CHAPTER_ID }],
        },
      },
      errors: [
        "`risk` reason 1: chapter `skipped-by-your-ignore-rules` doesn't exist. Chapter ids: links, auth.",
      ],
    },
  ])("rejects $name", ({ guide, errors }) => {
    const result = check(guide);
    expect(result.errors).toEqual(errors);
    expect(result.normalized).toBeNull();
  });

  it("warns when the top of the guide skips a high chapter or says too much", () => {
    const long =
      "This reason keeps going well past one short sentence, because it lists every file and every caller it touches, and then it says all of that again.";
    const result = check({
      ...rated,
      risk: {
        level: "high",
        reasons: ["One.", "Two.", "Three.", long].map((text) => ({ text, chapter: "auth" })),
      },
      chapters: [withRisk(linksChapter, { ...linksChapter.risk, level: "high" }), authChapter],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "`risk` has 4 reasons. Keep the 3 or fewer that decide the level.",
      "`risk` reason 4 is 27 words. Keep a reason to one short sentence, under 25.",
      "chapter `links` is high, but no `risk` reason names it. Give the pull request a reason that points at it, so the reviewer reads it first.",
    ]);
  });

  it("doesn't ask attempts from before risk to rate it", () => {
    const result = check(
      { ...unrated, chapters: [linksUnrated, authUnrated] },
      { ...context, signals: null },
    );
    expect(result.errors).toEqual([]);
    expect(result.normalized?.risk).toBeNull();
    expect(result.normalized?.signals).toEqual([]);
    expect(result.normalized?.chapters.map((chapter) => chapter.risk)).toEqual([null, null]);
  });

  it("reads revisions stored before risk with none", () => {
    const stored = Schema.decodeUnknownSync(NormalizedGuide)(aiStored);
    expect(stored.risk).toBeNull();
    expect(stored.signals).toEqual([]);
    expect(stored.chapters.every((chapter) => chapter.risk === null)).toBe(true);
  });

  it("streams a draft's risk before every chapter it names is written, without the guide's rules", () => {
    const draft = Schema.decodeUnknownSync(DraftGuide)({
      summary: "Checks links before storing them.",
      chapters: [withRisk(linksChapter, { ...linksChapter.risk, level: "high" })],
      risk: {
        level: "low",
        reasons: [
          { text: "Reads the session first.", chapter: "auth" },
          {
            text: "Rejects unsafe links.",
            chapter: "links",
            at: { path: "src/links.js", line: 11 },
          },
        ],
      },
    });
    const result = normalizeDraft(withoutUnwrittenChapters(draft), snapshot, context);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.risk).toEqual({
      level: "low",
      reasons: [
        { text: "Reads the session first.", chapter: null, at: null },
        { text: "Rejects unsafe links.", chapter: "links", at: { path: "src/links.js", line: 11 } },
      ],
    });
  });
});
