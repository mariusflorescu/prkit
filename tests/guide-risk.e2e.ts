import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { NormalizedGuide, type RiskLevel } from "../packages/contracts/src/guide.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { AGENT_RUNS, AGENT_SKIP, readRows } from "./fixturePr.ts";
import { lineOpener } from "./guideLines.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { pickGuideRepository } from "./pickers.ts";
import { setUpRealClaude } from "./realClaude.ts";

const KEY = "github.com/budget/fixtures#9";
const EVIDENCE = NodePath.join(repoRoot, ".e2e", "evidence", "guide-risk");
const decodeGuide = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));

const LINKS = [
  "export type Link = { readonly id: number; readonly url: string };",
  "",
  "const links: Array<Link> = [];",
  "",
  "export const addLink = (url: string): Link => {",
  "  const link = { id: links.length + 1, url };",
  "  links.push(link);",
  "  return link;",
  "};",
  "",
].join("\n");

const SESSION = [
  'import { randomBytes } from "node:crypto";',
  "",
  'import { db } from "../db.ts";',
  "",
  "export const createSession = (userId: number) => {",
  '  const token = randomBytes(32).toString("hex");',
  '  db.run("INSERT INTO sessions (user_id, token) VALUES (?, ?)", [userId, token]);',
  "  return token;",
  "};",
  "",
  "export const findSession = (token: string) =>",
  '  db.get("SELECT user_id FROM sessions WHERE token = ?", [token]);',
  "",
].join("\n");

/** Three pull requests that should come out low, medium and high, as PR 9 of the fake GitHub. */
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly level: RiskLevel;
  readonly signals: ReadonlyArray<string>;
  /** A Global "Always look closely at" path saved before the guide is written. */
  readonly lookClosely: string | null;
  readonly files: { readonly base: Record<string, string>; readonly head: Record<string, string> };
}> = [
  {
    name: "docs",
    level: "low",
    signals: [],
    lookClosely: null,
    files: {
      base: {
        "README.md": "# Links\n\nA tiny link shortner.\n\n## Setup\n\nRun `npm install`.\n",
        "src/links.ts": LINKS,
      },
      head: {
        "README.md": [
          "# Links",
          "",
          "A tiny link shortener that keeps your links in memory.",
          "",
          "## Setup",
          "",
          "1. Install the dependencies with `npm install`.",
          "2. Start the server with `npm start`. It listens on port 3000.",
          "",
          "## Adding a link",
          "",
          "Send `POST /links` with the URL as the body. The answer is the new link with its id.",
          "",
        ].join("\n"),
      },
    },
  },
  {
    name: "feature",
    level: "medium",
    signals: [],
    lookClosely: null,
    files: {
      base: {
        "src/links.ts": LINKS,
        "test/links.test.ts": [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          "",
          'import { addLink } from "../src/links.ts";',
          "",
          'test("a new link gets the next id", () => {',
          '  assert.equal(addLink("https://example.com").id, 1);',
          "});",
          "",
        ].join("\n"),
      },
      head: {
        "src/links.ts": [
          LINKS,
          "/**",
          " * The newest links first, `limit` at a time, starting after the link with id `before`.",
          " * Without a limit every link comes back, as before.",
          " */",
          "export const listLinks = (options: { readonly limit?: number; readonly before?: number } = {}) => {",
          "  const newest = [...links].reverse();",
          "  const start =",
          "    options.before === undefined",
          "      ? 0",
          "      : newest.findIndex((link) => link.id === options.before) + 1;",
          "  if (options.limit === undefined) return newest.slice(start);",
          "  const limit = Math.min(Math.max(options.limit, 1), 100);",
          "  return newest.slice(start, start + limit);",
          "};",
          "",
        ].join("\n"),
        "src/server.ts": [
          'import { addLink, listLinks } from "./links.ts";',
          "",
          "export const handle = (method: string, url: URL, body: string) => {",
          '  if (method === "POST" && url.pathname === "/links") return { status: 201, body: addLink(body) };',
          '  if (method === "GET" && url.pathname === "/links") {',
          '    const limit = url.searchParams.get("limit");',
          '    const before = url.searchParams.get("before");',
          '    if (limit !== null && !/^\\d+$/.test(limit)) return { status: 400, body: "limit must be a number" };',
          "    return {",
          "      status: 200,",
          "      body: listLinks({",
          "        ...(limit === null ? {} : { limit: Number(limit) }),",
          "        ...(before === null ? {} : { before: Number(before) }),",
          "      }),",
          "    };",
          "  }",
          '  return { status: 404, body: "not found" };',
          "};",
          "",
        ].join("\n"),
        "test/links.test.ts": [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          "",
          'import { addLink, listLinks } from "../src/links.ts";',
          "",
          'test("a new link gets the next id", () => {',
          '  assert.equal(addLink("https://example.com").id, 1);',
          "});",
          "",
          'test("links come newest first, a page at a time", () => {',
          '  addLink("https://example.com/b");',
          '  addLink("https://example.com/c");',
          "  assert.deepEqual(",
          "    listLinks({ limit: 2 }).map((link) => link.id),",
          "    [3, 2],",
          "  );",
          "  assert.deepEqual(",
          "    listLinks({ limit: 2, before: 2 }).map((link) => link.id),",
          "    [1],",
          "  );",
          "});",
          "",
        ].join("\n"),
      },
    },
  },
  {
    name: "auth-migration",
    level: "high",
    signals: ["sensitive", "migration", "untested"],
    lookClosely: "src/auth/",
    files: {
      base: {
        "src/auth/session.ts": SESSION,
        "db/migrations/0001_create_sessions.sql":
          "CREATE TABLE sessions (\n  id INTEGER PRIMARY KEY,\n  user_id INTEGER NOT NULL,\n  token TEXT NOT NULL\n);\n",
      },
      head: {
        "src/auth/session.ts": [
          'import { createHash, randomBytes } from "node:crypto";',
          "",
          'import { db } from "../db.ts";',
          "",
          'const hash = (token: string) => createHash("sha256").update(token).digest("hex");',
          "",
          "export const createSession = (userId: number) => {",
          '  const token = randomBytes(32).toString("hex");',
          '  db.run("INSERT INTO sessions (user_id, token_hash) VALUES (?, ?)", [userId, hash(token)]);',
          "  return token;",
          "};",
          "",
          "export const findSession = (token: string) =>",
          '  db.get("SELECT user_id FROM sessions WHERE token_hash = ?", [hash(token)]);',
          "",
        ].join("\n"),
        "db/migrations/0002_hash_session_tokens.sql": [
          "-- Stored tokens can't be hashed in SQL, so every session ends and users sign in again.",
          "DELETE FROM sessions;",
          "ALTER TABLE sessions DROP COLUMN token;",
          "ALTER TABLE sessions ADD COLUMN token_hash TEXT NOT NULL;",
          "CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash);",
          "",
        ].join("\n"),
      },
    },
  },
];

const guideUrl = (url: string) =>
  `${url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`;

const AUTH_FILES = CASES.find((entry) => entry.name === "auth-migration")?.files;

test(
  "look-closely paths at every scope reach the guide: the composer preview, the signal and the medium floor",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    if (AUTH_FILES === undefined) throw new Error("The auth-migration case is missing.");
    const name = "guide-risk-settings";
    const fake = await startFakeGitHub(name);
    const git = await cliFixture(fake, AUTH_FILES);
    // The composer's preview reads GitHub's file list, so the fake answers with the fixture's files.
    await fake.files(
      PR,
      Object.entries(AUTH_FILES.head).map(([filename, text]) => ({
        filename,
        status: filename in AUTH_FILES.base ? "modified" : "added",
        additions: text.split("\n").length - 1,
        deletions: 0,
        patch: "",
      })),
    );
    const claude = setUpFakeClaude(name);
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
      const addPath = async (form: ReturnType<typeof screen.getByRole>, pattern: string) => {
        await form.getByRole("button", "Add path").tap({ timeout: 30_000 });
        await form.getByRole("textbox", "Path 1").fill(pattern);
        await form.getByRole("button", "Save look-closely paths").tap();
        await expect(form.getByRole("button", "Save look-closely paths")).toBeHidden({
          timeout: 15_000,
        });
      };

      await app.open(`${run.url}/settings/guides`);
      const global = screen.getByRole("form", "Global look-closely paths");
      await addPath(global, "src/auth/");
      await global.scrollIntoView();
      await screenshotLightAndDark(app, browser, "risk-settings-global");
      await pickGuideRepository(screen, "budget/fixtures");
      const repository = screen.getByRole("form", "Repository look-closely paths");
      await addPath(repository, "db/migrations/");
      await repository.getByRole("button", "1 inherited, all on").tap();
      await expect(
        repository.getByRole("radiogroup", "src/auth/: inherit, on or off"),
      ).toBeVisible();
      await repository.scrollIntoView();
      await screenshotLightAndDark(app, browser, "risk-settings-repository");

      await app.open(guideUrl(run.url));
      const chip = screen.getByRole("group", "Guide settings").getByRole("button", /^Look closely/);
      await expect(chip).toHaveText("Look closely: 2 files", { timeout: 45_000 });
      await chip.tap();
      const own = screen.getByRole("form", "This pull request look-closely paths");
      await own.getByRole("button", "2 inherited, all on").tap();
      await own
        .getByRole("radiogroup", "db/migrations/: inherit, on or off")
        .getByRole("radio", "Off")
        .tap();
      await own.getByRole("button", "Save look-closely paths").tap();
      await expect(chip).toHaveText("Look closely: 1 file", { timeout: 15_000 });
      await expect(
        screen.getByRole("list", "Files that match look-closely paths").getByRole("listitem"),
      ).toHaveCount(1);
      await screenshotLightAndDark(app, browser, "risk-settings-composer");
      await browser.keyboard.press("Escape");

      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect
        .poll(
          () =>
            readRows(
              run.home,
              `SELECT json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${KEY}'`,
            )[0]?.state,
          { timeout: 120_000 },
        )
        .toBe("watching");
      const [attempt] = readRows(
        run.home,
        `SELECT json_extract(a.config, '$.signals') AS signals, json_extract(a.config, '$.sensitive') AS sensitive FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '${KEY}'`,
      );
      expect(JSON.parse(String(attempt?.signals))).toEqual([
        {
          _tag: "sensitive",
          files: [{ path: "src/auth/session.ts", pattern: "src/auth/", scope: "global" }],
        },
        { _tag: "migration", files: ["db/migrations/0002_hash_session_tokens.sql"] },
        { _tag: "untested", files: ["src/auth/session.ts"] },
      ]);
      expect(JSON.parse(String(attempt?.sensitive))).toMatchObject([
        { pattern: "src/auth/", scope: "global", active: true, decidedBy: null },
        {
          pattern: "db/migrations/",
          scope: "repository",
          active: false,
          decidedBy: "pull-request",
        },
      ]);

      const overview = screen.getByRole("region", "Risk");
      await expect(overview.getByText("Risk: Medium")).toBeVisible({ timeout: 30_000 });
      await overview.getByRole("button", "Look closely: 1 file").tap();
      const popup = screen.getByRole("dialog", "Look closely");
      await expect(popup.getByText("src/auth/ (Global)")).toBeVisible();
      await popup.getByRole("button", "Open src/auth/session.ts").tap();
      await expect(popup).toBeHidden();
      await expect(browser.locator("[data-roadmap-row] [data-risk-tag]")).toHaveText([
        "Risk: Medium",
      ]);
    } finally {
      restorePath();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

describe("a real Claude guide rates how carefully to read", { tags: ["agent"] }, () => {
  for (const entry of CASES)
    test(
      `a ${entry.name} pull request comes out ${entry.level}, and every reason opens its evidence`,
      { timeout: 900_000 },
      async ({ app, screen, browser }) => {
        test.skip(!AGENT_RUNS, AGENT_SKIP);
        const name = `guide-risk-${entry.name}`;
        NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });
        const claude = setUpRealClaude(name);
        const fake = await startFakeGitHub(name);
        const git = await cliFixture(fake, entry.files);
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

          if (entry.lookClosely !== null) {
            await app.open(`${run.url}/settings/guides`);
            const global = screen.getByRole("form", "Global look-closely paths");
            await global.getByRole("button", "Add path").tap({ timeout: 30_000 });
            await global.getByRole("textbox", "Path 1").fill(entry.lookClosely);
            await global.getByRole("button", "Save look-closely paths").tap();
            await expect(global.getByRole("button", "Save look-closely paths")).toHaveCount(0);
          }

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
          NodeFS.writeFileSync(NodePath.join(EVIDENCE, `${entry.name}.json`), stored.guide);
          const guide = decodeGuide(stored.guide);
          const risk = guide.risk;
          if (risk === null) throw new Error("The accepted guide has no risk.");
          console.info(
            `${entry.name}: ${risk.level}; ${risk.reasons.map((reason) => reason.text).join(" | ")}`,
          );
          expect(guide.signals.map((signal) => signal._tag)).toEqual(entry.signals);
          expect(risk.level).toBe(entry.level);
          expect(guide.chapters.every((chapter) => chapter.risk !== null)).toBe(true);
          const log = NodeFS.readFileSync(
            NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`),
            "utf8",
          );
          const label = `signals:${entry.signals.length === 0 ? "none" : entry.signals.join(",")}`;
          expect(log).toContain(label);

          const overview = screen.getByRole("region", "Risk");
          await expect(overview).toBeVisible({ timeout: 30_000 });
          const word = `${entry.level.charAt(0).toUpperCase()}${entry.level.slice(1)}`;
          await expect(overview.getByText(`Risk: ${word}`)).toBeVisible();
          await screenshotLightAndDark(app, browser, `risk-${entry.name}-overview`);
          const focused = () =>
            browser.evaluate(() => {
              const active = document.activeElement;
              return active instanceof HTMLElement ? (active.dataset.chapterId ?? null) : null;
            });
          const openLine = lineOpener(screen, browser);
          for (const [index, reason] of risk.reasons.entries()) {
            const row = overview.getByRole("listitem").nth(index);
            await overview.scrollIntoView();
            await row.getByRole("button", /^Open chapter \d+: /).tap();
            await expect.poll(focused).toBe(reason.chapter);
            if (reason.at === null) continue;
            await overview.scrollIntoView();
            const opened = await openLine(reason.at.path, reason.at.line);
            expect(opened.late).toMatchObject({ open: true, selected: [reason.at.line] });
          }
          for (const chapter of guide.chapters) {
            const section = browser.locator(`[data-chapter-id="${chapter.id}"]`);
            await section.scrollIntoView();
            await expect(
              browser.locator(
                `[data-chapter-id="${chapter.id}"] [data-chapter-meta] [data-risk-tag]`,
              ),
            ).toBeVisible();
            for (const reason of chapter.risk?.reasons ?? []) {
              if (reason.line !== null) {
                await section.scrollIntoView();
                const opened = await openLine(reason.file, reason.line);
                expect(opened.late).toMatchObject({ open: true, selected: [reason.line] });
              } else {
                await section.getByRole("button", `Open ${reason.file}`).tap();
                await expect
                  .poll(() =>
                    browser.evaluate(() =>
                      document.activeElement instanceof HTMLElement
                        ? (document.activeElement.dataset.path ?? null)
                        : null,
                    ),
                  )
                  .toBe(reason.file);
              }
            }
          }
          const first = browser.locator(`[data-chapter-id="${guide.chapters[0]?.id ?? ""}"]`);
          await first.scrollIntoView();
          await screenshotLightAndDark(app, browser, `risk-${entry.name}-chapter`);
          await browser.setViewport({ width: 640, height: 900 });
          await overview.scrollIntoView();
          await app.screenshot(`risk-${entry.name}-640`);
        } finally {
          restorePath();
          stopFakeInstance(name, { keepHome: false });
          fake.stop();
        }
      },
    );
});
