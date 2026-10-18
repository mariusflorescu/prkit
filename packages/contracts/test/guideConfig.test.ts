import { describe, expect, it } from "vite-plus/test";

import type { DiffFile } from "../src/diffSnapshot.ts";
import {
  emptyScopeConfig,
  GuideItemId,
  type GuideOverride,
  type ScopeConfig,
} from "../src/guideConfig.ts";
import {
  everythingSkippedMessage,
  ignoreMatcher,
  ignorePatternProblem,
  projectSnapshot,
  resolveGuideConfig,
  sensitiveMatcher,
} from "../src/guideConfigResolve.ts";

const id = GuideItemId.make;
const scope = (parts: {
  rules?: ReadonlyArray<readonly [string, string]>;
  ignoreOverrides?: ReadonlyArray<GuideOverride>;
  close?: ReadonlyArray<readonly [string, string]>;
  closeOverrides?: ReadonlyArray<GuideOverride>;
  areas?: ReadonlyArray<readonly [string, string, string]>;
  focusOverrides?: ReadonlyArray<GuideOverride>;
  guidance?: { text: string; mode: "append" | "replace" };
}): ScopeConfig => ({
  ignore: {
    version: 1,
    rules: (parts.rules ?? []).map(([ruleId, pattern]) => ({ id: id(ruleId), pattern })),
    overrides: parts.ignoreOverrides ?? [],
  },
  sensitive: {
    version: 1,
    rules: (parts.close ?? []).map(([ruleId, pattern]) => ({ id: id(ruleId), pattern })),
    overrides: parts.closeOverrides ?? [],
  },
  focus: {
    version: 1,
    areas: (parts.areas ?? []).map(([areaId, label, question]) => ({
      id: id(areaId),
      label,
      question,
    })),
    overrides: parts.focusOverrides ?? [],
  },
  guidance: { version: 1, ...(parts.guidance ?? { text: "", mode: "append" }) },
});
const off = (itemId: string): GuideOverride => ({ itemId: id(itemId), value: "off" });
const on = (itemId: string): GuideOverride => ({ itemId: id(itemId), value: "on" });

const file = (path: string, previousPath: string | null = null): DiffFile => ({
  path,
  previousPath,
  status: previousPath === null ? "modified" : "renamed",
  additions: 3,
  deletions: 1,
  patch: { _tag: "text", patch: "@@ -1 +1 @@\n-a\n+b" },
});
/** octocat/prkit-fixtures#1 */
const fixture = [
  file("src/server.js"),
  file("src/shorten.js"),
  file("src/store.js"),
  file("src/validate.js"),
  file("test/validate.test.js"),
];

const decisionsFor = (
  layers: Parameters<typeof resolveGuideConfig>[0],
  files: ReadonlyArray<DiffFile>,
) => {
  const decide = ignoreMatcher(resolveGuideConfig(layers).ignore);
  return files.map((entry) => {
    const decision = decide(entry);
    return {
      path: entry.path,
      skipped: decision.skipped,
      sides: decision.sides.map((side) => ({
        path: side.path,
        winner: side.winner === null ? null : `${side.winner.scope} ${side.winner.pattern}`,
        matches: side.matches.map(
          (rule) =>
            `${rule.scope} ${rule.pattern} ${rule.active ? "on" : "off"}${rule.decidedBy === null ? "" : ` by ${rule.decidedBy}`}`,
        ),
      })),
    };
  });
};

describe("ignore rules across scopes", () => {
  it("lets a repository negation keep one file a Global folder rule skips", () => {
    const decisions = decisionsFor(
      {
        global: scope({ rules: [["g-test", "test/"]] }),
        repository: scope({ rules: [["r-keep", "!test/validate.test.js"]] }),
        pullRequest: null,
      },
      fixture,
    );
    expect(decisions.at(-1)).toEqual({
      path: "test/validate.test.js",
      skipped: false,
      sides: [
        {
          path: "test/validate.test.js",
          winner: "repository !test/validate.test.js",
          matches: ["global test/ on", "repository !test/validate.test.js on"],
        },
      ],
    });
    expect(decisions[0]).toEqual({
      path: "src/server.js",
      skipped: false,
      sides: [{ path: "src/server.js", winner: null, matches: [] }],
    });
  });

  it("lets a PR switch back on a Global rule its repository switched off", () => {
    const layers = {
      global: scope({ rules: [["g-test", "test/"]] }),
      repository: scope({ ignoreOverrides: [off("g-test")] }),
      pullRequest: null,
    };
    expect(decisionsFor(layers, fixture).at(-1)?.skipped).toBe(false);
    expect(
      decisionsFor(
        { ...layers, pullRequest: scope({ ignoreOverrides: [on("g-test")] }) },
        fixture,
      ).at(-1),
    ).toEqual({
      path: "test/validate.test.js",
      skipped: true,
      sides: [
        {
          path: "test/validate.test.js",
          winner: "global test/",
          matches: ["global test/ on by pull-request"],
        },
      ],
    });
  });

  it("blocks generation when a PR rule skips everything, naming every deciding rule", () => {
    const resolved = resolveGuideConfig({
      global: scope({ rules: [["g-test", "test/"]] }),
      repository: null,
      pullRequest: scope({ rules: [["p-all", "src/"]] }),
    });
    const { reviewed, skipped } = projectSnapshot(resolved.ignore, { files: fixture });
    expect(reviewed.files).toEqual([]);
    expect(everythingSkippedMessage(skipped)).toBe(
      "Your ignore rules skip every changed file, so there is nothing to write a guide about. Rules that decided: `src/` (This pull request), `test/` (Global). Change them in Settings > Guides or in the composer, then generate again.",
    );
  });

  it("reviews a renamed file when either of its paths is kept", () => {
    const layers = {
      global: scope({ rules: [["g-src", "src/"]] }),
      repository: null,
      pullRequest: null,
    };
    const moved = file("lib/store.js", "src/store.js");
    expect(decisionsFor(layers, [moved])).toEqual([
      {
        path: "lib/store.js",
        skipped: false,
        sides: [
          { path: "lib/store.js", winner: null, matches: [] },
          { path: "src/store.js", winner: "global src/", matches: ["global src/ on"] },
        ],
      },
    ]);
    const both = resolveGuideConfig({
      ...layers,
      repository: scope({ rules: [["r-lib", "lib/"]] }),
    });
    expect(projectSnapshot(both.ignore, { files: [moved] }).skipped).toEqual([
      {
        path: "lib/store.js",
        previousPath: "src/store.js",
        additions: 3,
        deletions: 1,
        reasons: [
          { path: "lib/store.js", pattern: "lib/", scope: "repository" },
          { path: "src/store.js", pattern: "src/", scope: "global" },
        ],
      },
    ]);
  });

  it("matches patterns from the repository root, case-sensitively, with folder rules", () => {
    const paths = [
      "README.md",
      "docs/a.md",
      "pkg/docs/b.md",
      "pkg/__snapshots__/x.snap",
      "src/gen/a.gen.ts",
      "src/deep/gen/b.gen.ts",
      "Dist/index.js",
      "dist",
    ];
    const skippedBy = (pattern: string) => {
      const decide = ignoreMatcher(
        resolveGuideConfig({
          global: scope({ rules: [["only", pattern]] }),
          repository: null,
          pullRequest: null,
        }).ignore,
      );
      return paths.filter((path) => decide({ path, previousPath: null }).skipped);
    };
    expect(skippedBy("docs/")).toEqual(["docs/a.md", "pkg/docs/b.md"]);
    expect(skippedBy("/docs")).toEqual(["docs/a.md"]);
    expect(skippedBy("*.snap")).toEqual(["pkg/__snapshots__/x.snap"]);
    expect(skippedBy("src/**/*.gen.ts")).toEqual(["src/gen/a.gen.ts", "src/deep/gen/b.gen.ts"]);
    expect(skippedBy("src/*/*.gen.ts")).toEqual(["src/gen/a.gen.ts"]);
    expect(skippedBy("dist/")).toEqual([]);
    expect(skippedBy("dist")).toEqual(["dist"]);
    expect(skippedBy("README.[mM][dD]")).toEqual(["README.md"]);
  });

  it("explains why a pattern can't be saved", () => {
    expect(
      ["dist/", "!test/a.js", " dist", "!", "/", "a\\b", "./src", "a//b", "[ab", "**"].map(
        ignorePatternProblem,
      ),
    ).toEqual([
      null,
      null,
      "Remove the spaces at the start or end.",
      "Add a file, folder or glob, like `dist/` or `*.snap`.",
      "Add a file, folder or glob, like `dist/` or `*.snap`.",
      "Use `/` between folders.",
      "Patterns start at the repository root, so leave out `.` and `..`.",
      "Remove the doubled `/`.",
      "Close the `[` with a `]`.",
      null,
    ]);
  });

  it("leaves an override inactive once its item is deleted, and never attaches it to a new one", () => {
    const resolved = resolveGuideConfig({
      global: scope({ rules: [["g-new", "test/"]] }),
      repository: scope({ ignoreOverrides: [off("g-deleted")] }),
      pullRequest: null,
    });
    expect(resolved.dangling).toEqual([
      { scope: "repository", kind: "ignore", itemId: "g-deleted" },
    ]);
    expect(resolved.ignore).toEqual([
      { id: "g-new", pattern: "test/", scope: "global", active: true, decidedBy: null },
    ]);
  });
});

describe("focus areas and guidance across scopes", () => {
  const layers = {
    global: scope({
      areas: [["g-sec", "Security", "Is any input trusted without checks?"]],
      guidance: { text: "Keep chapters very short", mode: "append" },
    }),
    repository: scope({
      areas: [["r-mig", "Migrations", "Can these migrations run twice safely?"]],
    }),
    pullRequest: scope({
      focusOverrides: [off("r-mig")],
      guidance: { text: "Explain the validation logic in depth", mode: "append" },
    }),
  };

  it("answers only the areas still on, under a handle the agent can type", () => {
    expect(resolveGuideConfig(layers).focusAreas).toEqual([
      {
        id: "g-sec",
        label: "Security",
        question: "Is any input trusted without checks?",
        scope: "global",
        active: true,
        decidedBy: null,
        handle: "security",
      },
      {
        id: "r-mig",
        label: "Migrations",
        question: "Can these migrations run twice safely?",
        scope: "repository",
        active: false,
        decidedBy: "pull-request",
        handle: null,
      },
    ]);
  });

  it("appends guidance by scope, and a PR replace drops the less specific blocks", () => {
    expect(resolveGuideConfig(layers).guidance).toEqual([
      { scope: "global", text: "Keep chapters very short", replacedBy: null },
      { scope: "pull-request", text: "Explain the validation logic in depth", replacedBy: null },
    ]);
    const replaced = {
      ...layers,
      pullRequest: scope({
        focusOverrides: [off("r-mig")],
        guidance: { text: "Explain the validation logic in depth", mode: "replace" },
      }),
    };
    expect(resolveGuideConfig(replaced).guidance).toEqual([
      { scope: "global", text: "Keep chapters very short", replacedBy: "pull-request" },
      { scope: "pull-request", text: "Explain the validation logic in depth", replacedBy: null },
    ]);
    expect(resolveGuideConfig(replaced).hash).not.toBe(resolveGuideConfig(layers).hash);
  });

  it("keeps the hash when only switched-off items change", () => {
    const edited = {
      ...layers,
      repository: scope({
        areas: [["r-mig", "Migrations and data", "Can these run twice?"]],
        rules: [["r-off", "test/"]],
      }),
      pullRequest: scope({
        focusOverrides: [off("r-mig")],
        ignoreOverrides: [off("r-off")],
        guidance: { text: "Explain the validation logic in depth", mode: "append" },
      }),
    };
    expect(resolveGuideConfig(edited).hash).toBe(resolveGuideConfig(layers).hash);
    expect(
      resolveGuideConfig({ global: emptyScopeConfig, repository: null, pullRequest: null }).hash,
    ).toBe(
      resolveGuideConfig({
        global: emptyScopeConfig,
        repository: emptyScopeConfig,
        pullRequest: emptyScopeConfig,
      }).hash,
    );
  });

  it("gives areas with the same label distinct handles", () => {
    const handles = resolveGuideConfig({
      global: scope({ areas: [["a", "Security", "Inputs?"]] }),
      repository: scope({ areas: [["b", "Security", "Tokens?"]] }),
      pullRequest: null,
    }).focusAreas.map((area) => area.handle);
    expect(handles).toEqual(["security", "security-2"]);
  });
});

describe("look-closely paths", () => {
  const layers = {
    global: scope({
      rules: [["g-dist", "dist/"]],
      areas: [["g-sec", "Security", "Is any input trusted without checks?"]],
      guidance: { text: "Keep chapters very short", mode: "append" },
    }),
    repository: null,
    pullRequest: null,
  };
  /** What these settings hashed to before look-closely paths existed. */
  const hashBefore = "5bb868e86613e6b1";

  it("keeps every settings hash from before them until one is on", () => {
    expect(resolveGuideConfig(layers).hash).toBe(hashBefore);
    expect(
      resolveGuideConfig({
        ...layers,
        repository: scope({ close: [["r-auth", "src/auth/"]] }),
        pullRequest: scope({ closeOverrides: [off("r-auth")] }),
      }).hash,
    ).toBe(hashBefore);
    expect(
      resolveGuideConfig({ ...layers, repository: scope({ close: [["r-auth", "src/auth/"]] }) })
        .hash,
    ).not.toBe(hashBefore);
  });

  it("resolve like ignore rules across scopes, and match a rename by either path", () => {
    const resolved = resolveGuideConfig({
      global: scope({
        close: [
          ["g-auth", "src/auth/"],
          ["g-billing", "billing/"],
        ],
      }),
      repository: scope({
        close: [["r-readme", "!src/auth/README.md"]],
        closeOverrides: [off("g-billing"), off("g-deleted")],
      }),
      pullRequest: null,
    });
    const match = sensitiveMatcher(resolved.sensitive);
    expect(
      [
        { path: "src/auth/session.ts", previousPath: null },
        { path: "src/auth/README.md", previousPath: null },
        { path: "billing/charge.ts", previousPath: null },
        { path: "lib/session.ts", previousPath: "src/auth/session.ts" },
        { path: "src/app.ts", previousPath: null },
      ].map(match),
    ).toEqual([
      { path: "src/auth/session.ts", pattern: "src/auth/", scope: "global" },
      null,
      null,
      { path: "src/auth/session.ts", pattern: "src/auth/", scope: "global" },
      null,
    ]);
    expect(resolved.ignore).toEqual([]);
    expect(resolved.dangling).toEqual([
      { scope: "repository", kind: "sensitive", itemId: "g-deleted" },
    ]);
  });
});
