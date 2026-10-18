import { describe, expect, it } from "vite-plus/test";

import { makeGuideStream } from "./guideStream.ts";

// Claude's tool input arrives in fragments that split anywhere, even inside a string
// or an escape, and no run lets you choose where.
const input = JSON.stringify({
  summary: ["Links are checked before they are stored.", 'A bad one gets "400 {invalid}".'],
  steps: ["Validate", "Store"],
  flow: {
    title: "Shorten",
    nodes: [
      { id: "post", label: "POST /shorten", status: "unchanged" },
      { id: "check", label: "isValidUrl()", status: "added", chapter: "validate" },
    ],
    edges: [{ from: "post", to: "check" }],
  },
  chapters: [
    {
      id: "validate",
      title: "Reject bad links",
      kind: "core",
      files: ["src/validate.js"],
      risk: {
        level: "high",
        reasons: [{ text: "Decides what is stored", file: "src/validate.js" }],
      },
    },
    { id: "broken", title: 42, files: [] },
    {
      id: "tests",
      title: "Tests cover it",
      kind: "tests",
      body: "Path \\ and ] stay text.",
      files: ["test/a.js"],
    },
  ],
  risk: { level: "high", reasons: [{ text: "Bad links reach the store", chapter: "validate" }] },
  focus: [{ tone: "risk", text: "No length limit", chapter: "validate" }],
  focusAreas: [{ id: "x", verdict: "nothing-notable" }],
  guidanceNote: "None.",
});

const expected = [
  { summary: ["Links are checked before they are stored.", 'A bad one gets "400 {invalid}".'] },
  { steps: ["Validate", "Store"] },
  {
    flow: {
      title: "Shorten",
      nodes: [
        { id: "post", label: "POST /shorten", status: "unchanged" },
        { id: "check", label: "isValidUrl()", status: "added", chapter: "validate" },
      ],
      edges: [{ from: "post", to: "check" }],
    },
  },
  {
    chapters: [
      {
        id: "validate",
        title: "Reject bad links",
        kind: "core",
        files: ["src/validate.js"],
        risk: {
          level: "high",
          reasons: [{ text: "Decides what is stored", file: "src/validate.js" }],
        },
      },
    ],
  },
  {
    chapters: [
      {
        id: "tests",
        title: "Tests cover it",
        kind: "tests",
        body: "Path \\ and ] stay text.",
        files: ["test/a.js"],
      },
    ],
  },
  {
    risk: { level: "high", reasons: [{ text: "Bad links reach the store", chapter: "validate" }] },
  },
  { focus: [{ tone: "risk", text: "No length limit", chapter: "validate" }] },
];

describe("makeGuideStream", () => {
  it("hands back every finished field and chapter however the input is split", () => {
    for (const size of [1, 2, 3, 7, 32, input.length]) {
      const stream = makeGuideStream();
      const pieces = [];
      for (let start = 0; start < input.length; start += size)
        pieces.push(...stream.feed(input.slice(start, start + size)));
      expect(pieces).toEqual(expected);
    }
  });

  it("says the chapter list is open from its first bracket until it closes", () => {
    const stream = makeGuideStream();
    const open = input.indexOf("[", input.indexOf('"chapters"'));
    const close = input.indexOf('],"risk"');
    stream.feed(input.slice(0, open));
    expect(stream.chaptersOpen()).toBe(false);
    stream.feed(input.slice(open, close));
    expect(stream.chaptersOpen()).toBe(true);
    stream.feed(input.slice(close));
    expect(stream.chaptersOpen()).toBe(false);
  });
});
