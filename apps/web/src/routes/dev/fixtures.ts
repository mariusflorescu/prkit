import { DiffSnapshot, Guide, NormalizedGuide, normalizeGuide } from "@prkit/contracts";
import * as Schema from "effect/Schema";

export const fixtures = [
  {
    name: "github-gh-stack-91",
    label: "gh-stack #91",
    prUrl: "https://github.com/github/gh-stack/pull/91",
    dir: "github-gh-stack-91",
    file: "guide.json",
    stored: false,
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
] as const;

const sources = import.meta.glob<string>(
  "../../../../../packages/contracts/test/fixtures/*/*.json",
  { query: "?raw", import: "default" },
);
const readGuide = Schema.decodeUnknownSync(Schema.fromJsonString(Guide));
const readStored = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));
const readSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(DiffSnapshot));

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
  const result = normalizeGuide(readGuide(guideJson), snapshot);
  if (!result.normalized) throw new Error(result.errors.join("\n"));
  return { fixture, guide: result.normalized, snapshot, warnings: result.warnings };
}
