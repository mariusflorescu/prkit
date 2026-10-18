import {
  DiffSnapshot,
  Guide,
  GuideItemId,
  type GuideScopeName,
  NormalizedGuide,
  normalizeGuide,
  projectSnapshot,
  riskSignals,
  withSkippedChapter,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

type FixtureRule = { readonly pattern: string; readonly scope: GuideScopeName };

export const fixtures: ReadonlyArray<{
  readonly name: string;
  readonly label: string;
  readonly prUrl: string;
  readonly dir: string;
  readonly file: string;
  readonly stored: boolean;
  /** Settings the guide was written with, applied the way an attempt applies them. */
  readonly ignore?: ReadonlyArray<FixtureRule>;
  readonly sensitive?: ReadonlyArray<FixtureRule>;
}> = [
  {
    name: "github-gh-stack-91",
    label: "gh-stack #91",
    prUrl: "https://github.com/github/gh-stack/pull/91",
    dir: "github-gh-stack-91",
    file: "guide.json",
    stored: false,
    sensitive: [{ pattern: "cmd/", scope: "repository" }],
  },
  {
    name: "github-gh-stack-91-behavior",
    label: "gh-stack #91, behavior diff",
    prUrl: "https://github.com/github/gh-stack/pull/91",
    dir: "github-gh-stack-91",
    file: "behavior.json",
    stored: false,
  },
  {
    name: "pingdotgg-t3code-16353",
    label: "T3 Code #16353",
    prUrl: "https://github.com/pingdotgg/t3code/pull/16353",
    dir: "pingdotgg-t3code-16353",
    file: "guide.json",
    stored: false,
  },
  {
    name: "pingdotgg-t3code-16782",
    label: "T3 Code #16782",
    prUrl: "https://github.com/pingdotgg/t3code/pull/16782",
    dir: "pingdotgg-t3code-16782",
    file: "guide.json",
    stored: false,
    ignore: [{ pattern: "**/*.integration.test.ts", scope: "repository" }],
    sensitive: [
      { pattern: "packages/contracts/", scope: "global" },
      { pattern: "apps/server/src/mcp/", scope: "repository" },
      { pattern: "!**/*.test.ts", scope: "repository" },
    ],
  },
  {
    name: "vercel-ai-22182",
    label: "Vercel AI #22182",
    prUrl: "https://github.com/vercel/ai/pull/22182",
    dir: "vercel-ai-22182",
    file: "guide.json",
    stored: false,
  },
  {
    name: "vercel-ai-22182-stored",
    label: "Vercel AI #22182, stored before behavior diffs",
    prUrl: "https://github.com/vercel/ai/pull/22182",
    dir: "vercel-ai-22182",
    file: "stored.json",
    stored: true,
  },
];

const sources = import.meta.glob<string>(
  "../../../../../packages/contracts/test/fixtures/*/*.json",
  { query: "?raw", import: "default" },
);
const readGuide = Schema.decodeUnknownSync(Schema.fromJsonString(Guide));
const readStored = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));
const readSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(DiffSnapshot));

const effectiveRules = (rules: ReadonlyArray<FixtureRule> = []) =>
  rules.map((rule, index) => ({
    ...rule,
    id: GuideItemId.make(`fixture-${index}`),
    active: true,
    decidedBy: null,
  }));

export async function loadFixture(name: string) {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (!fixture)
    throw new Error(`No guide fixture named "${name}". Choose one of the fixtures above.`);
  const base = `../../../../../packages/contracts/test/fixtures/${fixture.dir}`;
  const guideSource = sources[`${base}/${fixture.file}`];
  const snapshotSource = sources[`${base}/snapshot.json`];
  if (!guideSource || !snapshotSource) throw new Error(`The files for "${name}" are missing.`);
  const [guideJson, snapshotJson] = await Promise.all([guideSource(), snapshotSource()]);
  const snapshot = readSnapshot(snapshotJson);
  if (fixture.stored) return { fixture, guide: readStored(guideJson), snapshot, warnings: [] };
  const guide = readGuide(guideJson);
  const { reviewed, skipped } = projectSnapshot(effectiveRules(fixture.ignore), snapshot);
  const context =
    guide.risk === undefined
      ? null
      : {
          focusAreas: [],
          skipped,
          signals: riskSignals({ reviewed, skipped, sensitive: effectiveRules(fixture.sensitive) }),
          preflight: null,
          manualCheck: guide.manualCheck !== undefined,
        };
  const result = normalizeGuide(guide, reviewed, context);
  if (!result.normalized) throw new Error(result.errors.join("\n"));
  return {
    fixture,
    guide: withSkippedChapter(result.normalized, skipped),
    snapshot,
    warnings: result.warnings,
  };
}
