import type { DiffFile } from "@prkit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { movesOf } from "./moves";

const file = (path: string, status: DiffFile["status"], patch: string): DiffFile => ({
  path,
  previousPath: null,
  status,
  additions: 0,
  deletions: 0,
  patch: { _tag: "text", patch },
});

const body = [
  "const trimmed = input.trim();",
  'if (trimmed === "") return null;',
  "const url = new URL(trimmed);",
  'url.hash = "";',
  'const params = [...url.searchParams.entries()].filter(([key]) => !key.startsWith("utm_"));',
  'const separator = "a b";',
  "url.search = new URLSearchParams(params).toString();",
  "return `${url.toString()}${separator}`;",
];
const landed = body
  .map((line) =>
    line.replace('!key.startsWith("utm_")', '!key.startsWith("utm_") && key !== "fbclid"'),
  )
  .map((line) => line.replace('"a b"', '"ab"'));

/** Old lines 4-14 of links.js cut, new lines 1-12 of urls.js added. */
const links = file(
  "src/links.js",
  "modified",
  [
    "@@ -1,14 +1,3 @@",
    " // Helpers for links.",
    " export const MAX = 2048;",
    " ",
    "-export function normalizeUrl(input) {",
    ...body.map((line) => `-  ${line}`),
    "-}",
    "-",
  ].join("\n"),
);
const urls = file(
  "src/urls.js",
  "added",
  [
    "@@ -0,0 +1,12 @@",
    "+export const urls = {",
    "+  normalize(input) {",
    ...landed.map((line) => `+    ${line}`),
    "+  },",
    "+};",
  ].join("\n"),
);

describe("moves", () => {
  it("reads a re-indented function moved to another file as one move, keeping what changed on the way colored", () => {
    const moves = movesOf([links, urls]);
    const [move] = moves.get("src/urls.js")?.landed ?? [];
    expect(moves.get("src/links.js")?.cut).toEqual([move]);
    expect(move?.from).toEqual({ path: "src/links.js", side: "old", start: 5, end: 12 });
    expect(move?.to).toEqual({ path: "src/urls.js", side: "new", start: 3, end: 10 });
    // The filter that changed, and the string whose spacing changed, stay colored on both sides.
    expect([...(moves.get("src/urls.js")?.quiet.new ?? [])]).toEqual([3, 4, 5, 6, 9, 10]);
    expect([...(moves.get("src/links.js")?.quiet.old ?? [])]).toEqual([5, 6, 7, 8, 11, 12]);
    expect(move?.edited).toBe(2);
  });
});
