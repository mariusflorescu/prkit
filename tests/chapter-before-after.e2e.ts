import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { NormalizedGuide } from "../packages/contracts/src/guide.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { AGENT_RUNS, AGENT_SKIP, readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { setUpRealClaude } from "./realClaude.ts";

const PR = 9;
const KEY = `github.com/budget/fixtures#${PR}`;
const EVIDENCE = NodePath.join(repoRoot, ".e2e", "evidence", "chapter-before-after");
const decodeGuide = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));

const links = (name: string) =>
  [
    "export type Link = { readonly id: number; readonly url: string };",
    "",
    "const links: Array<Link> = [];",
    "",
    `export const ${name} = (url: string): Link => {`,
    "  const link = { id: links.length + 1, url };",
    "  links.push(link);",
    "  return link;",
    "};",
    "",
  ].join("\n");

const server = (name: string) =>
  [
    `import { ${name} } from "./links.ts";`,
    "",
    "export const handle = (method: string, url: URL, body: string) => {",
    `  if (method === "POST" && url.pathname === "/links") return { status: 201, body: ${name}(body) };`,
    '  return { status: 404, body: "not found" };',
    "};",
    "",
  ].join("\n");

const linksTest = (name: string) =>
  [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "",
    `import { ${name} } from "../src/links.ts";`,
    "",
    'test("a new link gets the next id", () => {',
    `  assert.equal(${name}("https://example.com").id, 1);`,
    "});",
    "",
  ].join("\n");

/**
 * A change whose logic keeps its shape: `addLink` is renamed `createLink` everywhere, and a
 * slug helper nothing calls yet arrives with its own test. Nothing here worked one way and
 * now works another, so no chapter has a before to show.
 */
const FILES = {
  base: {
    "README.md": "# Links\n\nSend `POST /links` with a URL. `addLink` stores it.\n",
    "src/links.ts": links("addLink"),
    "src/server.ts": server("addLink"),
    "test/links.test.ts": linksTest("addLink"),
  },
  head: {
    "README.md": "# Links\n\nSend `POST /links` with a URL. `createLink` stores it.\n",
    "src/links.ts": links("createLink"),
    "src/server.ts": server("createLink"),
    "test/links.test.ts": linksTest("createLink"),
    "src/slug.ts": [
      "/** A short, readable slug for a URL: its host and first path segment, lowercased. */",
      "export const slugFor = (url: string) => {",
      "  const { hostname, pathname } = new URL(url);",
      '  const first = pathname.split("/").find((part) => part !== "") ?? "";',
      '  return [hostname.replace(/^www\\./u, ""), first]',
      "    .filter(Boolean)",
      '    .join("-")',
      "    .toLowerCase()",
      '    .replace(/[^a-z0-9-]+/gu, "-");',
      "};",
      "",
    ].join("\n"),
    "test/slug.test.ts": [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      "",
      'import { slugFor } from "../src/slug.ts";',
      "",
      'test("a slug is the host and the first path segment", () => {',
      '  assert.equal(slugFor("https://www.Example.com/Docs/intro"), "example-com-docs");',
      "});",
      "",
    ].join("\n"),
  },
};

const guideUrl = (url: string) =>
  `${url}/pr/github.com/budget/fixtures/${PR}?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`;

describe(
  "a real Claude guide writes a chapter before/after only where logic changed shape",
  {
    tags: ["agent"],
  },
  () => {
    test(
      "a rename and a new helper get no before/after",
      { timeout: 900_000 },
      async ({ app, screen, browser }) => {
        test.skip(!AGENT_RUNS, AGENT_SKIP);
        const name = "chapter-before-after-none";
        NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });
        const claude = setUpRealClaude(name);
        const fake = await startFakeGitHub(name);
        const git = await cliFixture(fake, FILES);
        const path = process.env.PATH;
        const restorePath = () => {
          if (path === undefined) delete process.env.PATH;
          else process.env.PATH = path;
        };
        process.env.PATH = git.path;
        try {
          const run = startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]);
          restorePath();
          await emulateOsColorScheme(browser, "light");
          await browser.setViewport({ width: 1440, height: 900 });
          await app.open(run.openUrl);
          await app.open(guideUrl(run.url));
          await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
          await expect
            .poll(
              () => {
                const [review] = readRows(
                  run.home,
                  `SELECT json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${KEY}'`,
                );
                return review?.state === "watching" || review?.state === "failed"
                  ? review.state
                  : "running";
              },
              { timeout: 840_000, interval: 1_000 },
            )
            .toBe("watching");

          const [stored] = readRows(
            run.home,
            `SELECT rr.guide FROM review_revisions rr JOIN reviews r ON r.id = rr.review_id WHERE r.pr_key = '${KEY}' AND rr.revision = 1`,
          );
          if (typeof stored?.guide !== "string") throw new Error("Revision 1 stored no guide.");
          NodeFS.mkdirSync(EVIDENCE, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(EVIDENCE, "none.json"), stored.guide);
          const guide = decodeGuide(stored.guide);
          console.info(
            guide.chapters
              .map(
                (chapter) =>
                  `${chapter.id} (${chapter.kind}): ${chapter.pseudocode === null ? "no pseudocode" : typeof chapter.pseudocode === "string" ? "one block" : "a pair"}`,
              )
              .join(" | "),
          );
          expect(
            guide.chapters.filter(
              (chapter) => chapter.pseudocode !== null && typeof chapter.pseudocode !== "string",
            ),
          ).toEqual([]);

          await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 30_000 });
          for (const chapter of guide.chapters)
            await expect(browser.locator(`[data-chapter-id="${chapter.id}"]`)).toBeAttached();
          await expect(browser.locator("[data-pseudocode-pair]")).toHaveCount(0);
          const first = browser.locator(`[data-chapter-id="${guide.chapters[0]?.id ?? ""}"]`);
          await first.scrollIntoView();
          await screenshotLightAndDark(app, browser, "chapter-before-after-none");
        } finally {
          restorePath();
          stopFakeInstance(name, { keepHome: false });
          fake.stop();
        }
      },
    );
  },
);
