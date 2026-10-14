import { DiffSnapshot, Guide, normalizeGuide } from "@prkit/contracts";
import * as Schema from "effect/Schema";

export const fixtures = [
  {
    name: "github-gh-stack-91",
    label: "gh-stack #91",
    prUrl: "https://github.com/github/gh-stack/pull/91",
  },
  {
    name: "pingdotgg-t3code-16353",
    label: "T3 Code #16353",
    prUrl: "https://github.com/pingdotgg/t3code/pull/16353",
  },
  {
    name: "pingdotgg-t3code-16782",
    label: "T3 Code #16782",
    prUrl: "https://github.com/pingdotgg/t3code/pull/16782",
  },
  {
    name: "vercel-ai-22182",
    label: "Vercel AI #22182",
    prUrl: "https://github.com/vercel/ai/pull/22182",
  },
] as const;

const sources = import.meta.glob<string>(
  "../../../../../packages/contracts/test/fixtures/*/*.json",
  { query: "?raw", import: "default" },
);
const readGuide = Schema.decodeUnknownSync(Schema.fromJsonString(Guide));
const readSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(DiffSnapshot));

export async function loadFixture(name: string) {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (!fixture)
    throw new Error(`No guide fixture named "${name}". Choose one of the fixtures above.`);
  const base = `../../../../../packages/contracts/test/fixtures/${name}`;
  const guideSource = sources[`${base}/guide.json`];
  const snapshotSource = sources[`${base}/snapshot.json`];
  if (!guideSource || !snapshotSource) throw new Error(`The files for "${name}" are missing.`);
  const [guideJson, snapshotJson] = await Promise.all([guideSource(), snapshotSource()]);
  const snapshot = readSnapshot(snapshotJson);
  const result = normalizeGuide(readGuide(guideJson), snapshot);
  if (!result.normalized) throw new Error(result.errors.join("\n"));
  return { fixture, guide: result.normalized, snapshot, warnings: result.warnings };
}
