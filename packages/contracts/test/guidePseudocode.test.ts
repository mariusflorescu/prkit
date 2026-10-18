import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { DiffFile } from "../src/diffSnapshot.ts";
import { Guide } from "../src/guide.ts";
import { normalizeGuide } from "../src/guideNormalize.ts";
import { pseudocodeRows } from "../src/guidePseudocode.ts";

const file = (path: string, status: DiffFile["status"]): DiffFile => ({
  path,
  previousPath: null,
  status,
  additions: 2,
  deletions: 1,
  patch: { _tag: "text", patch: "@@ -10,2 +10,3 @@\n context\n-old\n+new\n+more" },
});
const snapshot = {
  files: [file("src/tokens.js", "modified"), file("src/fresh.js", "added")],
};
const check = (guide: object) =>
  normalizeGuide(Schema.decodeUnknownSync(Guide)(guide), snapshot, null);

const chapter = (overrides: object) => ({
  id: "tokens",
  title: "Expire reset tokens",
  kind: "core",
  body: "`verifyToken` turns an expired token away.",
  files: ["src/tokens.js"],
  ...overrides,
});
const guideWith = (overrides: { readonly files?: ReadonlyArray<string> }) => {
  const claimed = overrides.files?.[0] ?? "src/tokens.js";
  const other = claimed === "src/fresh.js" ? "src/tokens.js" : "src/fresh.js";
  return {
    summary: "Reset links expire after an hour.",
    chapters: [chapter(overrides), chapter({ id: "rest", title: "The rest", files: [other] })],
    flow: { title: "Change", nodes: [{ id: "a" }], edges: [] },
  };
};

const before = "verifyToken(token)\n  row = find(token)\n  if no row: 404\n  return row.user";
const after =
  "verifyToken(token)\n  row = find(token)\n  if no row: 404\n  if row.expiresAt is past: 410\n  return row.user";
const pair = { before, after };

describe("a chapter's pseudocode", () => {
  it("stores a pair tidied: line endings, trailing spaces and blank edge lines gone", () => {
    const result = check(
      guideWith({
        pseudocode: {
          before: `\n\n${before.replaceAll("\n", "  \r\n")}\n\n`,
          after,
        },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.normalized?.chapters[0]?.pseudocode).toEqual(pair);
  });

  it("stores a plain string exactly as sent", () => {
    const text = "  fetch(url)\r\n\r\n  retry with backoff  ";
    const result = check(guideWith({ pseudocode: text }));
    expect(result.errors).toEqual([]);
    expect(result.normalized?.chapters[0]?.pseudocode).toBe(text);
  });

  it("accepts a pair with no shared line, and warns that every line will show as changed", () => {
    const result = check(
      guideWith({ pseudocode: { before: "look up the row", after: "check the clock" } }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "chapter `tokens`: `pseudocode.before` and `pseudocode.after` share no line, so every line shows as changed. Write the lines that work the same word for word, indentation included, on both sides.",
    ]);
    expect(result.normalized).not.toBeNull();
  });

  it("warns once per side about a line too wide for side by side", () => {
    const wide = `${"a".repeat(80)}\n${"b".repeat(90)}`;
    const result = check(guideWith({ pseudocode: { before: `x\n${wide}`, after: `y\n${wide}` } }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "chapter `tokens`: `pseudocode.before` line 2 is 80 characters. Keep lines under about 60 so the two sides fit side by side.",
      "chapter `tokens`: `pseudocode.after` line 2 is 80 characters. Keep lines under about 60 so the two sides fit side by side.",
    ]);
  });

  it.each([
    {
      name: "a pair with no before",
      chapter: { pseudocode: { after } },
      error:
        "chapter `tokens`: `pseudocode.before` is empty. A pair shows logic that already existed and changed shape. For code this PR only adds, send `pseudocode` as one string, or leave it out.",
    },
    {
      name: "a pair with no after",
      chapter: { pseudocode: { before, after: "\n  \n" } },
      error:
        "chapter `tokens`: `pseudocode.after` is empty. For logic this PR removes, say in the body what is gone and leave `pseudocode` out.",
    },
    {
      name: "a pair that shows no change",
      chapter: { pseudocode: { before, after: `${before}  \r\n` } },
      error:
        "chapter `tokens`: `pseudocode.before` and `pseudocode.after` are the same, so the pair shows no change. Show what changed between them, or send `pseudocode` as one string.",
    },
    {
      name: "a side over 10 lines",
      chapter: {
        pseudocode: { before, after: Array.from({ length: 11 }, (_, i) => `step ${i}`).join("\n") },
      },
      error:
        "chapter `tokens`: `pseudocode.after` is 11 lines - past 10 it stops being a quick read. Keep the 3-8 lines that show the change and leave the rest to the diff.",
    },
    {
      name: "a pair in a tests chapter",
      chapter: { kind: "tests", pseudocode: pair },
      error:
        "chapter `tokens` is a `tests` chapter, and a before/after is for logic that changed shape. Send `pseudocode` as one string, or leave it out.",
    },
    {
      name: "a pair in a chapter whose files are all new",
      chapter: { files: ["src/fresh.js"], pseudocode: pair },
      error:
        "chapter `tokens`: every file is new in this PR, so there is no before. Send `pseudocode` as one string. If this code replaces logic from a file the PR deletes, put that file in this chapter.",
    },
  ])("rejects $name", ({ chapter: overrides, error }) => {
    const result = check(guideWith(overrides));
    expect(result.errors).toEqual([error]);
    expect(result.normalized).toBeNull();
  });

  it("splits a pair into rows: shared lines on both sides, and a filler across from the longer side", () => {
    expect(
      pseudocodeRows({
        before: "find the row\nreturn the user",
        after: "find the row\nif expiresAt is past: 410\nreturn the user\nlog it",
      }),
    ).toEqual([
      {
        before: { text: "find the row", status: "unchanged" },
        after: { text: "find the row", status: "unchanged" },
      },
      { before: null, after: { text: "if expiresAt is past: 410", status: "added" } },
      {
        before: { text: "return the user", status: "unchanged" },
        after: { text: "return the user", status: "unchanged" },
      },
      { before: null, after: { text: "log it", status: "added" } },
    ]);
    expect(pseudocodeRows({ before: "a\nold\nb", after: "a\nnew\nb" })[1]).toEqual({
      before: { text: "old", status: "removed" },
      after: { text: "new", status: "added" },
    });
  });
});
