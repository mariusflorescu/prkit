import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import * as Schema from "effect/Schema";
import { expect } from "e2e";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import { NormalizedGuide } from "../packages/contracts/src/guide.ts";
import { pseudocodeRows } from "../packages/contracts/src/guidePseudocode.ts";
import { runForUrl } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { transcriptOf } from "./fixActions.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  agentPid,
  FIXTURE_FILES,
  FIXTURE_NAME,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  openFixtureGuide,
  prPath,
  processGroup,
  readRows,
} from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { prScrolls } from "./prScrolls.ts";
import { closeReviewFixture, createReviewFixture } from "./reviewFixture.ts";

const CODEX_RUNS = process.env.PRKIT_E2E_CODEX === "1";
const FIXTURE_KEY = `github.com/${FIXTURE_REPO}#1`;

const decodeStoredGuide = Schema.decodeSync(Schema.fromJsonString(NormalizedGuide));

const newLineSelected = ({ path, line }: { path: string; line: number }) => {
  const card = document.querySelector(`[data-file-diff-card][data-path="${CSS.escape(path)}"]`);
  const roots = [...(card?.querySelectorAll("*") ?? [])].flatMap((element) =>
    element.shadowRoot === null ? [] : [element.shadowRoot],
  );
  return roots.some((root) =>
    [...root.querySelectorAll(`[data-gutter] > [data-column-number="${line}"]`)].some((cell) => {
      const code = cell.closest("code");
      if (code === null || !(cell instanceof HTMLElement)) return false;
      const old =
        code.hasAttribute("data-deletions") ||
        (!code.hasAttribute("data-additions") && cell.dataset.lineType === "change-deletion");
      return !old && cell.hasAttribute("data-selected-line");
    }),
  );
};

/**
 * What of the user's own Codex setup reached these transcripts: the lines of the AGENTS.md
 * in their Codex home, and the wrappers Codex puts around instructions and the skills list.
 * Counts only, because that file is private.
 */
const userInstructionsIn = (transcripts: ReadonlyArray<string>) => {
  const file = NodePath.join(
    process.env.CODEX_HOME ?? NodePath.join(NodeOs.homedir(), ".codex"),
    "AGENTS.md",
  );
  const lines = NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 20)
    : [];
  const found = (needle: string) => transcripts.some((text) => text.includes(needle));
  return {
    agentsMdLines: lines.filter((line) => found(JSON.stringify(line).slice(1, -1))).length,
    agentsMdFragment: found("# AGENTS.md instructions"),
    skillsList: found("<skills_instructions>"),
  };
};

test(
  "the Guide tab sets a guide up with the agent, model and its settings, and a focus on request",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen }) => {
    await openFixtureGuide({ app, screen });
    await expect(screen.getByRole("form", "Start a guide")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByRole("heading", "No guide yet")).toBeVisible();
    // guide-config's ignore rules stay in the run's home, so how many files the agent reads
    // depends on which file ran first. `guide-config` checks those sentences; the count holds.
    await expect(screen.getByText(/ 5 changed files/)).toBeVisible();
    await screen.getByRole("button", "Add a focus").tap();
    await expect(screen.getByRole("textbox", "Guidance for this pull request")).toBeFocused();
    const picker = screen.getByRole("button", /^Agent and model: /);
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await app.screenshot("guide-setup");

    await picker.tap();
    await expect(screen.getByRole("combobox", "Search models")).toBeVisible();
    // Every provider is listed with the login it runs on; a logged-out one shows its fix.
    await expect(screen.getByRole("listbox")).toContainText("Claude");
    await expect(screen.getByRole("listbox")).toContainText("Codex");
    if (process.env.PRKIT_E2E_CODEX_LOGGED_OUT === "1")
      await expect(screen.getByRole("status", "Codex isn't ready")).toContainText("codex login");
    await expect(screen.getByRole("option", /Claude Opus 5\.5/)).toBeVisible();
    await app.screenshot("guide-model-list");
    await screen.getByRole("combobox", "Search models").fill("opus");
    await screen.getByRole("option", /Claude Opus 5\.5/).tap();
    await expect(screen.getByRole("button", "Agent and model: Claude Opus 5.5")).toBeVisible();

    // The model's own settings: Opus advertises reasoning effort and fast mode.
    await screen.getByRole("button", /^Claude Opus 5\.5 settings: /).tap();
    await expect(screen.getByRole("menuitemradio", "High")).toBeVisible();
    await screen.getByRole("menuitemradio", "High").tap();
    await expect(screen.getByRole("button", "Claude Opus 5.5 settings: High")).toBeVisible();
    await expect(screen.getByRole("button", "Generate guide")).toBeVisible();
  },
);

test(
  "Settings > Agents keeps the default agent, and the Guide tab starts from it",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    await app.open(runForUrl(app.baseUrl).openUrl);
    await screen.getByRole("link", "Inbox").tap();
    await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+Comma`);
    await screen.getByRole("navigation", "Settings sections").getByRole("link", "Agents").tap();
    const agents = screen.getByRole("region", "Agents");
    await expect(agents).toBeVisible({ timeout: 30_000 });
    await agents.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
    await screen.getByRole("combobox", "Search models").fill("sonnet");
    await screen.getByRole("option", /Claude Sonnet 5\.5/).tap();
    await expect(agents.getByRole("button", "Agent and model: Claude Sonnet 5.5")).toBeVisible();
    await app.screenshot("settings-agents-default");
    const [saved] = readRows(
      runForUrl(app.baseUrl).home,
      "SELECT value FROM settings WHERE key = 'guides.defaultAgent'",
    );
    expect(saved).toEqual({
      value: '{"instance":"claude","model":"claude-sonnet-5-5","options":[]}',
    });
    await openFixtureGuide({ app, screen });
    await expect(screen.getByRole("button", "Agent and model: Claude Sonnet 5.5")).toBeVisible({
      timeout: 30_000,
    });
  },
);

test(
  "a guide from a stand-in agent fails, writes and is ready with a toast, and the page never scrolls",
  { skip: NEEDS_FIXTURE, timeout: 180_000 },
  async ({ app, screen, browser }) => {
    const claude = setUpFakeClaude("guide-stand-in");
    const run = startInstance("guide-stand-in", ["--claude", claude.file]);
    try {
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
      await screen
        .getByRole("region", "Yours")
        .getByRole("link", /#1 Validate links and count clicks/)
        .tap({ timeout: 45_000 });
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
      await expect(screen.getByRole("button", /^Agent and model: /)).toBeVisible({
        timeout: 30_000,
      });
      expect(await prScrolls(browser)).toEqual({ page: false, view: false });
      await screenshotLightAndDark(app, browser, "guide-setup");

      claude.failing(true);
      await screen.getByRole("button", "Generate guide").tap();
      const failed = screen.getByRole("alert");
      await expect(failed).toContainText("The stand-in agent was told to fail.", {
        timeout: 60_000,
      });
      expect(await prScrolls(browser)).toEqual({ page: false, view: false });
      const inTab = (selector: string) => browser.locator(`[data-active-tab="true"] ${selector}`);
      await expect(inTab("[data-guide-warning]")).toBeVisible();
      await screenshotLightAndDark(app, browser, "guide-failed");

      claude.failing(false);
      claude.hold();
      await failed.getByRole("button", "Retry").tap();
      await expect(screen.getByRole("status", "What the agent is doing")).toContainText(
        "Reading the change with a stand-in agent",
        { timeout: 60_000 },
      );
      expect(await prScrolls(browser)).toEqual({ page: false, view: false });
      // The tab's ring holds still at what is done: no file read yet.
      await expect(inTab("[data-guide-progress]")).toHaveAttribute("data-guide-progress", "0");
      await expect(inTab("[data-guide-warning]")).toHaveCount(0);
      expect(
        await browser.evaluate(
          () =>
            document
              .querySelector('[data-active-tab="true"] [data-guide-progress]')
              ?.getAnimations({ subtree: true }).length ?? null,
        ),
      ).toBe(0);
      await inTab("a[data-open-pr]").hover();
      await expect(browser.locator("[data-tab-guide-progress]")).toHaveText(
        "Writing guide · 0/5 files",
      );
      await screenshotLightAndDark(app, browser, "guide-writing");

      // Looking at another tab when the guide lands: the toast says so and opens it.
      await screen.getByRole("link", "Inbox").tap();
      claude.release();
      const toast = screen.getByRole("dialog", "Guide ready");
      await expect(toast).toContainText("Validate links and count clicks · 1 chapter", {
        timeout: 60_000,
      });
      await app.screenshot("guide-ready-toast");
      await toast.getByRole("button", "Open").tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ");
      await expect(screen.getByRole("heading", "Every change")).toBeVisible();
      // The guide is longer than the window: its own area scrolls, the page doesn't.
      expect(await prScrolls(browser)).toEqual({ page: false, view: true });
      await screenshotLightAndDark(app, browser, "guide-ready");
      await screen.getByRole("button", "Generate again with other settings").tap();
      await expect(screen.getByRole("form", "Start a guide")).toBeVisible();
      await screenshotLightAndDark(app, browser, "guide-generate-again");
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("form", "Start a guide")).toBeHidden();

      // A chapter's diff takes review comments too, and the draft shows in Files.
      const stop = screen
        .getByRole("region", "src/validate.js")
        .getByRole("button", /^Comment on (old )?line \d+$/);
      const at = (await stop.getAttribute("aria-label"))?.replace("Comment on ", "") ?? "";
      await stop.tap();
      await screen.getByRole("textbox", `Comment on ${at}`).fill("Noted from the guide.");
      await screen.getByRole("textbox", `Comment on ${at}`).press("Meta+Enter");
      const draft = screen.getByRole("article", `Pending comment on src/validate.js ${at}`);
      await expect(draft).toBeVisible();
      await app.screenshot("guide-chapter-draft");
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
      await expect(draft).toBeVisible({ timeout: 30_000 });
    } finally {
      // A turn stopped mid-write would otherwise keep polling its flags until the instance stops.
      claude.release();
      claude.failing(false);
      stopFakeInstance("guide-stand-in", { keepHome: false });
    }
  },
);

describe("guide generation with Codex", { tags: ["codex"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Codex narrates, checks off files, streams a draft and writes the guide",
    { timeout: 660_000 },
    async ({ app, screen, browser }) => {
      test.skip(
        !CODEX_RUNS,
        "Spends your ChatGPT subscription. Run with PRKIT_E2E_CODEX=1 --tag codex.",
      );
      const run = runForUrl(app.baseUrl);
      await openFixtureGuide({ app, screen });
      await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("GPT");
      await screen.getByRole("option", /GPT/).first().tap();
      await expect(screen.getByRole("button", /^Agent and model: GPT/)).toBeVisible();
      await app.screenshot("codex-selected");
      const started = Date.now();
      await screen.getByRole("button", "Generate guide").tap();
      await expect(browser.locator('[data-attempt-file][data-read="read"]').first()).toBeVisible({
        timeout: 120_000,
      });
      await expect(screen.getByRole("status", "What the agent is doing")).toBeVisible();
      await app.screenshot("codex-reading");
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 600_000,
      });
      await expect(screen.getByRole("heading", "Overview")).toBeVisible();
      for (const path of FIXTURE_FILES)
        await expect(browser.locator("[data-guide-view]")).toContainText(path);
      await app.screenshot("codex-guide");
      const [review] = readRows(
        run.home,
        `SELECT id, provider, model, session_id FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
      );
      const [attempt] = readRows(
        run.home,
        "SELECT outcome, agent_pid, draft_version FROM review_attempts ORDER BY rowid DESC LIMIT 1",
      );
      expect(review?.provider).toBe("codex");
      expect(typeof review?.session_id).toBe("string");
      expect(attempt?.outcome).toBe("accepted");
      if (typeof review?.id !== "string" || typeof attempt?.agent_pid !== "number")
        throw new Error("The Codex attempt didn't save its review or process id.");
      expect(
        readRows(
          run.home,
          `SELECT COUNT(*) AS read FROM review_attempt_files WHERE read_at IS NOT NULL`,
        ),
      ).toEqual([{ read: FIXTURE_FILES.length }]);
      expect(
        NodeChildProcess.execFileSync(
          "git",
          ["-C", NodePath.join(run.home, "worktrees", review.id), "status", "--porcelain"],
          { env: childEnv(process.env), encoding: "utf8" },
        ),
      ).toBe("");
      expect(
        NodeChildProcess.spawnSync("ps", ["-p", String(attempt.agent_pid), "-o", "pid="], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe("");
      const transcripts = transcriptOf(
        run.home,
        "codex",
        NodePath.join(run.home, "worktrees", review.id),
        String(review.session_id),
      );
      const userInstructions = userInstructionsIn(transcripts);
      const evidenceDir = NodePath.resolve(import.meta.dirname, "../.e2e/evidence/codex-provider");
      NodeFS.mkdirSync(evidenceDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(evidenceDir, "e2e-generation.json"),
        JSON.stringify(
          { clickToGuideMs: Date.now() - started, review, attempt, userInstructions },
          null,
          2,
        ),
      );
      expect({ transcripts: transcripts.length, ...userInstructions }).toEqual({
        transcripts: 1,
        agentsMdLines: 0,
        agentsMdFragment: false,
        skillsList: false,
      });
      await screen.getByRole("button", "Stop watching").tap();
      await screen.getByRole("button", "Generate again").tap();
      await expect(browser.locator('[data-review-status="writing"]')).toBeVisible({
        timeout: 30_000,
      });
      const latestPid = () =>
        readRows(run.home, "SELECT agent_pid FROM review_attempts ORDER BY rowid DESC LIMIT 1")[0]
          ?.agent_pid;
      await expect.poll(latestPid, { timeout: 60_000 }).toEqual(expect.any(Number));
      const [resumed] = readRows(
        run.home,
        `SELECT provider, model, session_id FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
      );
      // Generate again keeps the review's agent, model and conversation.
      expect(resumed).toEqual({
        provider: "codex",
        model: review.model,
        session_id: review.session_id,
      });
      const runningPid = latestPid();
      if (typeof runningPid !== "number")
        throw new Error("The resumed turn didn't save its process id.");
      await screen.getByRole("button", "Stop").tap();
      await expect(browser.locator('[data-review-status="done"]')).toBeAttached({
        timeout: 30_000,
      });
      expect(NodeFS.readdirSync(NodePath.join(run.home, "worktrees"))).toEqual([]);
      expect(
        NodeChildProcess.spawnSync("ps", ["-p", String(runningPid), "-o", "pid="], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe("");
      await app.screenshot("codex-stopped-after-resume");
    },
  );
});

describe("guide generation with the user's agent", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Generate narrates, checks off files, shows the draft early and writes the guide",
    { timeout: 660_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      await emulateOsColorScheme(browser, "light");
      await openFixtureGuide({ app, screen });
      await screen.getByRole("button", "Add a focus").tap({ timeout: 30_000 });
      await screen
        .getByRole("textbox", "Guidance for this pull request")
        .fill("How a rejected URL reaches the client");
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(browser.locator('[data-review-status="writing"]')).toBeAttached({
        timeout: 30_000,
      });
      await expect(browser.locator('[data-narration="agent"]')).toBeVisible({ timeout: 60_000 });
      await expect(browser.locator('[data-attempt-file][data-read="read"]').first()).toBeVisible({
        timeout: 60_000,
      });
      await app.screenshot("guide-reading");
      // Read while it writes: the overview shows while the progress line is still up.
      await expect(
        browser.locator("[data-progress-label] ~ *, [data-guide-summary]").first(),
      ).toBeVisible({ timeout: 300_000 });
      await app.screenshot("guide-draft");

      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 600_000,
      });
      await expect(screen.getByRole("heading", "Overview")).toBeVisible();
      await expect(browser.locator('[data-review-status="watching"]')).toBeVisible();
      await expect(browser.locator("[data-agent-label]")).toContainText("Claude");
      for (const path of FIXTURE_FILES)
        await expect(browser.locator("[data-guide-view]")).toContainText(path);
      await app.screenshot("guide-overview");

      const [review] = readRows(
        run.home,
        `SELECT provider, model FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
      );
      expect(review).toEqual({ provider: "claude", model: expect.any(String) });
      // The setup's focus is the PR's guidance block, saved when the guide started.
      expect(
        readRows(
          run.home,
          `SELECT value FROM guide_config WHERE scope = 'pull-request:${FIXTURE_KEY}' AND section = 'guidance'`,
        ),
      ).toEqual([{ value: '{"text":"How a rejected URL reaches the client","mode":"append"}' }]);
      const [attempt] = readRows(
        run.home,
        "SELECT outcome, narration FROM review_attempts ORDER BY rowid DESC LIMIT 1",
      );
      expect(attempt).toEqual({ outcome: "accepted", narration: expect.any(String) });
      expect(readRows(run.home, "SELECT revision FROM review_revisions")).toEqual([
        { revision: 1 },
      ]);

      const [accepted] = readRows(run.home, "SELECT guide FROM review_revisions");
      if (typeof accepted?.guide !== "string")
        throw new Error("The accepted revision has no stored guide.");
      const { flow, chapters } = decodeStoredGuide(accepted.guide);
      console.info(
        flow === null
          ? "before/after: none"
          : flow._tag === "graph"
            ? `before/after: graph, ${flow.nodes.length} nodes`
            : `before/after: behavior, ${flow.rows.length} rows`,
      );
      const card = browser.locator("[data-flow-card]");
      if (flow === null) await expect(card).toHaveCount(0);
      else {
        await card.scrollIntoView();
        await expect(card.getByRole("button", /^(Before|After)$/)).toHaveCount(0);
        await app.screenshot("guide-before-after");
      }
      if (flow?._tag === "graph") {
        await expect(browser.locator("[data-flow-card] [data-flow-legend]")).toBeVisible();
        await expect(browser.locator("[data-flow-card] [data-flow-node]")).toHaveCount(
          flow.nodes.length,
        );
      }
      if (flow?._tag === "behavior")
        for (const [index, row] of flow.rows.entries()) {
          await screen.getByRole("button", `Open ${row.at.path} line ${row.at.line}`).first().tap();
          await expect
            .poll(() => browser.evaluate(newLineSelected, row.at), { timeout: 10_000 })
            .toBe(true);
          if (index === 0) await app.screenshot("guide-before-after-line");
        }

      const pairs = chapters.flatMap((chapter) =>
        chapter.pseudocode === null || typeof chapter.pseudocode === "string"
          ? []
          : [{ id: chapter.id, kind: chapter.kind, rows: pseudocodeRows(chapter.pseudocode) }],
      );
      console.info(
        `chapter before/after: ${pairs.map((pair) => `${pair.id} (${pair.kind}, ${pair.rows.length} rows)`).join(", ") || "none"}`,
      );
      await expect(browser.locator("[data-pseudocode-pair]")).toHaveCount(pairs.length);
      for (const [index, pair] of pairs.entries()) {
        expect(["tests", "docs", "generated"]).not.toContain(pair.kind);
        const side = (name: string) =>
          `[data-chapter-id="${pair.id}"] [data-pseudocode-side="${name}"] [data-pseudocode-line]`;
        await browser
          .locator(`[data-chapter-id="${pair.id}"] [data-pseudocode-pair]`)
          .scrollIntoView();
        await expect(browser.locator(`${side("before")}[data-status="removed"]`)).toHaveCount(
          pair.rows.filter((row) => row.before?.status === "removed").length,
        );
        await expect(browser.locator(`${side("after")}[data-status="added"]`)).toHaveCount(
          pair.rows.filter((row) => row.after?.status === "added").length,
        );
        if (index === 0) await screenshotLightAndDark(app, browser, "guide-chapter-before-after");
      }

      await screen.getByRole("button", "Stop watching").tap();
      await expect(screen.getByRole("status", "Guide status")).toContainText(
        "Not watching for new commits",
      );
      await expect(screen.getByRole("heading", "Overview")).toBeVisible();
      await app.screenshot("guide-stopped-still-readable");
    },
  );

  test(
    "Stop while writing ends the review, its checkout and its agent's processes within 10 s",
    { timeout: 300_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      const fixture = createReviewFixture(`${Date.now()}`, "guide stop");
      const key = `github.com/${FIXTURE_REPO}#${fixture.number}`;
      try {
        await app.open(run.openUrl);
        await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "guide")}`);
        await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
        await expect(
          browser.locator('[data-active-tab="true"] [data-review-status="writing"]'),
        ).toBeAttached({ timeout: 60_000 });
        await expect
          .poll(() => agentPid(run.home, key), { timeout: 60_000 })
          .toEqual(expect.any(Number));
        const agent = agentPid(run.home, key);
        if (agent === null) throw new Error("The attempt didn't record its agent's process.");
        const running = processGroup(agent);
        expect(running).toContain(agent);
        expect(
          NodeChildProcess.execFileSync("ps", ["-o", "command=", "-p", String(agent)], {
            encoding: "utf8",
          }),
        ).toContain("claude");
        await app.screenshot("guide-writing-before-stop");

        await screen.getByRole("button", "Stop").tap();
        const stopped = Date.now();
        await expect.poll(() => processGroup(agent), { timeout: 10_000 }).toEqual([]);
        const goneMs = Date.now() - stopped;
        await expect(
          browser.locator('[data-active-tab="true"] [data-review-status="done"]'),
        ).toBeAttached({ timeout: 30_000 });
        await expect(screen.getByRole("button", /^Generate (guide|again)$/)).toBeVisible();
        await app.screenshot("guide-stopped-while-writing");

        const [review] = readRows(
          run.home,
          `SELECT id, status FROM reviews WHERE pr_key = '${key}'`,
        );
        expect(review?.status).toBe('{"_tag":"done","reason":"stopped"}');
        expect(NodeFS.existsSync(NodePath.join(run.home, "worktrees", String(review?.id)))).toBe(
          false,
        );
        const evidenceDir = NodePath.resolve(import.meta.dirname, "../.e2e/evidence/guide-stop");
        NodeFS.mkdirSync(evidenceDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(evidenceDir, `${new Date().toISOString().replaceAll(":", "-")}.json`),
          JSON.stringify({ agent, processesBeforeStop: running, goneMs }, null, 2),
        );
      } finally {
        closeReviewFixture(fixture);
      }
    },
  );

  test(
    "Cmd+G, the inbox row and the command palette start a guide with the default agent",
    { timeout: 240_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      const modifier = await browser.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
      );
      const stopRunning = async () => {
        await expect(
          browser.locator(
            '[data-active-tab="true"] :is([data-review-status="preparing"], [data-review-status="writing"])',
          ),
        ).toBeAttached({
          timeout: 60_000,
        });
        await screen.getByRole("button", "Stop").tap({ timeout: 30_000 });
        // Scoped to the active tab: #1's tab can also show a finished review from earlier journeys.
        await expect(
          browser.locator('[data-active-tab="true"] [data-review-status="done"]'),
        ).toBeAttached({
          timeout: 30_000,
        });
      };
      // The inbox row: its hover action writes a guide in the background. PR #2 has no
      // review yet; the journeys above leave one on #1.
      await app.open(run.openUrl);
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
      const row = browser.locator(`a[data-pr-number="2"][data-repository="${FIXTURE_REPO}"]`);
      await row.hover({ timeout: 45_000 });
      await screen.getByRole("button", `Generate guide for ${FIXTURE_REPO} #2`).tap();
      await expect(browser.locator('[data-guide-mark="writing"]')).toBeVisible({ timeout: 30_000 });
      await app.screenshot("inbox-row-writing");
      await row.tap();
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
      await stopRunning();

      // The command palette, from the PR's Conversation.
      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("link", "Conversation")
        .tap();
      await browser.keyboard.press(`${modifier}+k`);
      await screen.getByRole("searchbox", "Find a pull request").fill("generate");
      await screen.getByRole("button", /Generate guide/).tap();
      await stopRunning();

      // Cmd+G on the Guide tab submits the setup.
      await expect(screen.getByRole("form", "Start a guide")).toBeVisible({ timeout: 30_000 });
      await browser.keyboard.press(`${modifier}+g`);
      await stopRunning();
      expect(
        readRows(
          run.home,
          `SELECT COUNT(*) AS attempts FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = 'github.com/${FIXTURE_REPO}#2'`,
        ),
      ).toEqual([{ attempts: 3 }]);
    },
  );
});
