import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { RevisionResult } from "../apps/server/src/outside/paritySchemas.ts";
import { GuideResult } from "../apps/server/src/outside/schemas.ts";
import { NormalizedGuide } from "../packages/contracts/src/guide.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { FILES } from "./contextFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { AGENT_RUNS, AGENT_SKIP, readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { setUpRealClaude } from "./realClaude.ts";

const KEY = "github.com/budget/fixtures#9";
const OWN = "budget-test";
const SECOND = "budget-second";
/** Leaves out the 64-character slug cap PR 9 adds, and claims trimming that nothing does. */
const DESCRIPTION =
  "Raises the URL limit to 2048 characters.\n\nAlso trims whitespace from slugs before they are stored.";
const PREFLIGHT = {
  questions: [{ text: "Why is the slug limit **64**?", at: { path: "src/limits.ts", line: 3 } }],
  description: [
    {
      kind: "missing-from-description",
      text: "The description doesn't mention the new 64-character slug cap.",
      chapter: "every-change",
    },
    {
      kind: "missing-from-code",
      text: "Nothing in the diff trims slugs.",
      quote: "trims whitespace from slugs",
    },
  ],
  tests: [{ text: "No test calls `cutSlug()`.", path: "src/slug.ts", line: 3 }],
};
const SECTION = "Before you ask for review";

const reviewState = (home: string) =>
  readRows(
    home,
    `SELECT latest_revision AS revision, json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${KEY}'`,
  );
const storedGuide = (home: string) => {
  const text = readRows(
    home,
    `SELECT rr.guide FROM review_revisions rr JOIN reviews r ON r.id = rr.review_id WHERE r.pr_key = '${KEY}' ORDER BY rr.revision DESC LIMIT 1`,
  )[0]?.guide;
  if (typeof text !== "string") throw new Error("No revision stored a guide.");
  return Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide))(text);
};
const guideUrl = (url: string) =>
  `${url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent(`github.com/${OWN}`)}&tab=guide`;

/** The fake's PR 9, opened by `author` with `body`, and an instance reading it with `claude`. */
const bringUp = async (
  name: string,
  claude: string,
  author: string,
  body: string,
  secondAccount = false,
) => {
  NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });
  const fake = await startFakeGitHub(name, { secondAccount });
  const git = await cliFixture(fake, FILES);
  await fake.describe(9, { author, body });
  const launch = () => {
    const path = process.env.PATH;
    process.env.PATH = git.path;
    try {
      return startFakeInstance(name, fake, [
        "--claude",
        claude,
        "--watch-interval",
        "5000",
        "--e2e",
      ]);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  };
  return { fake, git, run: launch(), launch };
};

const generate = async (
  { app, screen }: Pick<TestFixtures, "app" | "screen">,
  run: { url: string; home: string; openUrl: string },
  timeout = 120_000,
) => {
  await app.open(run.openUrl);
  await app.open(guideUrl(run.url));
  await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
  await expect
    .poll(
      () => {
        const state = reviewState(run.home)[0]?.state;
        return state === "watching" || state === "failed" ? state : "running";
      },
      { timeout, interval: 500 },
    )
    .not.toBe("running");
  expect(reviewState(run.home)).toEqual([{ revision: 1, state: "watching" }]);
};

const inView = (browser: Browser, path: string) =>
  browser.evaluate((target: string) => {
    const card = document.querySelector(`[data-file-diff-card][data-path="${target}"]`);
    const box = card?.getBoundingClientRect();
    return box !== undefined && box.top < window.innerHeight && box.bottom > 0;
  }, path);

/** What the installed `prkit` command prints for PR 9, read through `login`. */
const readThrough = (
  home: string,
  fake: FakeGitHub,
  login: string,
  command: ReadonlyArray<string>,
) => {
  const result = NodeChildProcess.spawnSync(
    NodePath.join(home, "bin/prkit"),
    [...command, "budget/fixtures#9", "--account", `github.com/${login}`, "--json"],
    {
      encoding: "utf8",
      env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
    },
  );
  if (result.status !== 0) throw new Error(`prkit ${command.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const editsOf = async (fake: FakeGitHub) =>
  (await fake.writes()).filter((write) => write.kind === "PATCH pulls/9");

test(
  "the author sees the pre-flight with its evidence, outside agents reading through another account don't, and it survives a relaunch",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "author-preflight";
    const claude = setUpFakeClaude(name);
    claude.preflight(PREFLIGHT);
    const { fake, run, launch } = await bringUp(name, claude.file, OWN, DESCRIPTION, true);
    try {
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 900 });
      await generate({ app, screen }, run);
      const [prompt] = claude.prompts();
      expect(prompt?.prompt).toContain("so the guide is for its own author");
      expect(prompt?.prompt).not.toContain("The description is empty");
      expect(storedGuide(run.home).preflight).toEqual({
        questions: [
          {
            text: "Why is the slug limit **64**?",
            chapter: "every-change",
            at: { path: "src/limits.ts", line: 3 },
          },
        ],
        description: [
          {
            kind: "missing-from-description",
            text: "The description doesn't mention the new 64-character slug cap.",
            chapter: "every-change",
            at: null,
          },
          {
            kind: "missing-from-code",
            text: "Nothing in the diff trims slugs.",
            quote: "trims whitespace from slugs",
          },
        ],
        tests: [{ text: "No test calls `cutSlug()`.", path: "src/slug.ts", line: 3 }],
      });

      const section = screen.getByRole("region", SECTION);
      await expect(section).toContainText(
        "Only you see this, because you opened this pull request.",
      );
      const asked = section.getByRole("list", "Reviewers will probably ask");
      await expect(asked).toContainText("Why is the slug limit 64?");
      await expect(asked.getByRole("button", "Open src/limits.ts line 3")).toHaveText(
        "limits.ts:3",
      );
      const claims = section.getByRole("list", "The description and the code");
      await expect(
        claims.getByRole("listitem", /^Not in the description: The description doesn't mention/),
      ).toBeVisible();
      await expect(
        claims.getByRole("listitem", "Not in the code: Nothing in the diff trims slugs."),
      ).toContainText("trims whitespace from slugs");
      const missing = section.getByRole("list", "Tests that look missing");
      await expect(missing).toContainText("src/slug.ts");
      await expect(missing).toContainText("+3 -0");
      await expect(
        section.getByRole("button", "Update the description from the guide"),
      ).toBeVisible();
      await section.scrollIntoView();
      await screenshotLightAndDark(app, browser, "preflight-wide");

      await missing.getByRole("button", "Open src/slug.ts line 3").tap();
      await expect.poll(() => inView(browser, "src/slug.ts")).toBe(true);

      await browser.setViewport({ width: 720, height: 900 });
      await section.scrollIntoView();
      await screenshotLightAndDark(app, browser, "preflight-narrow");

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
      const latest = (login: string) =>
        Schema.decodeSync(Schema.fromJsonString(GuideResult))(
          readThrough(run.home, fake, login, ["guide", "read"]),
        ).guide?.content.preflight;
      const revision = (login: string) =>
        Schema.decodeSync(Schema.fromJsonString(RevisionResult))(
          readThrough(run.home, fake, login, ["guide", "revision", "--revision", "1"]),
        );
      expect(latest(OWN)?.description).toHaveLength(2);
      expect(latest(SECOND)).toBeNull();
      expect(revision(OWN).config.preflight).toEqual({ description: DESCRIPTION });
      expect(revision(SECOND)).toMatchObject({
        content: { preflight: null },
        config: { preflight: null },
      });

      stopFakeInstance(name, { keepHome: true });
      const again = launch();
      await app.open(again.openUrl);
      await app.open(guideUrl(again.url));
      await expect(screen.getByRole("region", SECTION)).toContainText(
        "Nothing in the diff trims slugs.",
        { timeout: 45_000 },
      );
      expect(await editsOf(fake)).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "someone else's pull request gets no pre-flight and no description action",
  { timeout: 300_000 },
  async ({ app, screen }) => {
    const name = "author-preflight-other";
    const claude = setUpFakeClaude(name);
    claude.preflight(PREFLIGHT);
    const { fake, run } = await bringUp(name, claude.file, "outsider", DESCRIPTION);
    try {
      await generate({ app, screen }, run);
      expect(claude.prompts()[0]?.prompt).not.toContain("so the guide is for its own author");
      expect(storedGuide(run.home).preflight).toBeNull();
      await expect(screen.getByRole("heading", "Overview")).toBeVisible();
      await expect(screen.getByRole("region", SECTION)).toBeHidden();
      await expect(
        screen.getByRole("button", "Update the description from the guide"),
      ).toBeHidden();
      await app.screenshot("preflight-other");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "the description update shows its change, writes only on Save, survives a conflict and a refusal, and undoes",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "author-preflight-description";
    const claude = setUpFakeClaude(name);
    const BODY = "Raises the URL limit to 2048 characters.";
    const MEANWHILE = "Changed on GitHub while the editor was open.";
    const draftOn = (current: string) =>
      `${current}\n\n<!-- prkit guide -->\n## What changed\n\nA guide written by the stand-in agent.\n\n### Reading order\n\n1. Every change\n<!-- /prkit guide -->`;
    const { fake, git, run } = await bringUp(name, claude.file, OWN, BODY);
    try {
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 900 });
      await generate({ app, screen }, run);
      const section = screen.getByRole("region", SECTION);
      await expect(section).toContainText("Nothing to flag");

      await section.getByRole("button", "Update the description from the guide").tap();
      const editor = screen.getByRole("form", "Update the description");
      await expect(editor.getByRole("button", "Changes")).toHaveAttribute("aria-pressed", "true");
      await editor.scrollIntoView();
      await screenshotLightAndDark(app, browser, "description-changes");
      await editor.getByRole("button", "Cancel").tap();
      await expect(editor).toBeHidden();
      expect(await editsOf(fake)).toEqual([]);

      await section.getByRole("button", "Update the description from the guide").tap();
      await editor.getByRole("button", "Edit").tap();
      const text = editor.getByRole("textbox", "Description");
      await expect(text).toHaveValue(draftOn(BODY));
      await editor.getByRole("button", "Replace it").tap();
      await expect(text).toHaveValue(draftOn(BODY).slice(BODY.length + 2));
      await editor.getByRole("button", "Add a section").tap();
      const edited = `${draftOn(BODY)}\n\nThanks for reading.`;
      await text.fill(edited);
      await expect(editor.getByRole("button", "Replace it")).toBeDisabled();
      await editor.getByRole("button", "Add a section").tap();
      await expect(text).toHaveValue(edited);
      await git.commit({ "src/extra.ts": "export const extra = 1;\n" }, "Add an extra file");
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 2, state: "watching" }]);
      await expect(text).toHaveValue(edited);
      await screenshotLightAndDark(app, browser, "description-edit");

      await fake.describe(9, { body: MEANWHILE });
      await editor.getByRole("button", "Save to GitHub").tap();
      await expect(editor.getByRole("alert")).toHaveText(
        "The description changed on GitHub after prkit read it. Refresh to see the new one, then try again.",
      );
      await expect(text).toHaveValue(edited);
      expect(await editsOf(fake)).toEqual([]);
      await editor.getByRole("button", "Cancel").tap();
      await expect(section).toContainText(
        "You changed the description after this guide was written",
        {
          timeout: 30_000,
        },
      );

      await section.getByRole("button", "Update the description from the guide").tap();
      await editor.getByRole("button", "Edit").tap();
      await expect(text).toHaveValue(draftOn(MEANWHILE));
      await fake.fail("rest:pull-edit", 1, 422, "Validation Failed");
      await editor.getByRole("button", "Save to GitHub").tap();
      await expect(editor.getByRole("alert")).toHaveText("Validation Failed");
      await expect(editor.getByRole("button", "Retry")).toBeVisible();
      await expect(text).toHaveValue(draftOn(MEANWHILE));
      await app.screenshot("description-refused");
      await editor.getByRole("button", "Retry").tap();
      await expect(screen.getByText("Description updated on GitHub")).toBeVisible();
      await expect(editor).toBeHidden();
      expect(await editsOf(fake)).toEqual([
        { kind: "PATCH pulls/9", input: { body: draftOn(MEANWHILE) } },
        { kind: "PATCH pulls/9", input: { body: draftOn(MEANWHILE) } },
      ]);
      expect((await fake.stats()).byKind["rest:pull-edit:failed"]).toBe(1);
      await app.screenshot("description-saved");

      await screen.getByRole("button", "Undo").tap();
      await expect(screen.getByText("Description put back")).toBeVisible();
      expect((await editsOf(fake)).at(-1)).toEqual({
        kind: "PATCH pulls/9",
        input: { body: MEANWHILE },
      });

      await browser.setViewport({ width: 720, height: 900 });
      await section.getByRole("button", "Update the description from the guide").tap();
      await editor.scrollIntoView();
      await screenshotLightAndDark(app, browser, "description-narrow");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

describe("the author's pre-flight from a real Claude", { tags: ["agent"] }, () => {
  test(
    "on the author's own PR it catches the change the description leaves out and the claim nothing does",
    { timeout: 900_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const name = "author-preflight-claude";
      const claude = setUpRealClaude(name);
      const { fake, run } = await bringUp(name, claude.file, OWN, DESCRIPTION);
      try {
        await emulateOsColorScheme(browser, "light");
        await browser.setViewport({ width: 1280, height: 900 });
        await generate({ app, screen }, run, 600_000);
        const preflight = storedGuide(run.home).preflight;
        if (preflight === null) throw new Error("The guide has no pre-flight.");
        console.log(JSON.stringify(preflight, null, 2));
        expect(preflight.description.map((item) => item.kind)).toContain(
          "missing-from-description",
        );
        expect(
          preflight.description.some(
            (item) => item.kind !== "missing-from-description" && /trim/i.test(item.quote),
          ),
        ).toBe(true);
        const section = screen.getByRole("region", SECTION);
        await expect(section).toContainText("Not in the description");
        await section.scrollIntoView();
        await screenshotLightAndDark(app, browser, "preflight-claude");
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "on someone else's PR it writes no pre-flight",
    { timeout: 900_000 },
    async ({ app, screen }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const name = "author-preflight-claude-other";
      const claude = setUpRealClaude(name);
      const { fake, run } = await bringUp(name, claude.file, "outsider", DESCRIPTION);
      try {
        await generate({ app, screen }, run, 600_000);
        expect(storedGuide(run.home).preflight).toBeNull();
        await expect(screen.getByRole("heading", "Overview")).toBeVisible();
        await expect(screen.getByRole("region", SECTION)).toBeHidden();
        await app.screenshot("preflight-claude-other");
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );
});
