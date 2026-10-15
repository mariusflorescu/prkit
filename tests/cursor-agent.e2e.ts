import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { draftOn } from "./fixActions.ts";
import { type ProbeStep, setUpFakeCursor } from "./fakeCursor.ts";
import {
  startFakeGitHub,
  startFakeInstance,
  startInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { closeFixFixture, createFixFixture } from "./fixFixture.ts";
import { FIXTURE_REPO, NEEDS_FIXTURE, prPath, readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";

const NAME = "cursor-agent";
const CURSOR_REASON =
  "Cursor fixes edit files only: Cursor can't ask before each command, so it never runs this repository's scripts.";

/** prkit's file tools Cursor gets for every turn, and its MCP tools for a guide and a fix. */
const READ_TOOLS = ["read_file", "list_dir", "glob", "grep"];
const GUIDE_TOOLS = [
  "submit_guide",
  "revise_guide",
  "submit_draft",
  "note_file",
  "report_progress",
];
const FIX_TOOLS = ["finish_fixes", "finish_conflicts", "report_progress"];
/** Some of Cursor's own tools, every one of them refused. */
const NEVER = ["read_tool_call", "edit_tool_call", "shell_tool_call", "web_fetch_tool_call"];
/** Reads and writes past the checkout, into its git data, and into Cursor's settings. */
const PROBE: ReadonlyArray<ProbeStep> = [
  { tool: "read_file", args: { path: "../escape.txt" } },
  { tool: "read_file", args: { path: "/etc/hosts" } },
  { tool: "read_file", args: { path: ".git/config" } },
  { tool: "list_dir", args: { path: ".." } },
  { tool: "glob", args: { pattern: "../**" } },
  { tool: "grep", args: { pattern: "localhost", path: "/etc" } },
  { tool: "write_file", args: { path: "../escape.txt", content: "out" } },
  { tool: "write_file", args: { path: ".cursor/sandbox.json", content: "{}" } },
  { tool: "write_file", args: { path: "sandbox.json", content: "{}" } },
  { tool: "edit_file", args: { path: ".git/config", old_string: "[", new_string: "[" } },
];

const modifierOf = (browser: Browser) =>
  browser.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));

/** Light and dark, once every open dialog has faded in. */
const shoot = async (app: TestFixtures["app"], browser: Browser, name: string) => {
  await expect
    .poll(() =>
      browser.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].every(
          (popup) => getComputedStyle(popup).opacity === "1",
        ),
      ),
    )
    .toBe(true);
  await screenshotLightAndDark(app, browser, name);
};

const openAgents = async (screen: Screen, browser: Browser) => {
  await browser.keyboard.press(`${await modifierOf(browser)}+Comma`);
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "Agents").tap();
  return screen.getByRole("region", "Agents").getByRole("list", "Agents");
};

/** Settings > Agents: installs Cursor support from its card, then signs in for prkit. */
const installAndSignIn = async (
  fixtures: Pick<TestFixtures, "app" | "screen"> & { browser: Browser },
  cursor: ReturnType<typeof setUpFakeCursor>,
  shots: boolean,
) => {
  const { app, screen, browser } = fixtures;
  const card = (await openAgents(screen, browser)).getByRole("listitem", "Cursor");
  const status = card.getByRole("status", "Cursor status");
  await expect(status).toHaveText("Not installed", { timeout: 30_000 });
  await expect(card.getByRole("link", "Cursor's Terms of Service")).toHaveAttribute(
    "href",
    "https://cursor.com/terms-of-service",
  );
  if (shots) await shoot(app, browser, "u68-cursor-not-installed");
  await card.getByRole("button", "Install Cursor support").tap();
  await expect(status).toHaveText("Not signed in", { timeout: 60_000 });
  await expect(card).toContainText(
    "Signing in creates a Cursor API key for prkit that lasts 90 days and shows in your Cursor dashboard.",
  );
  if (shots) await shoot(app, browser, "u68-cursor-installed");
  await card.getByRole("button", "Sign in with Cursor").tap();
  const signingIn = card.getByRole("status", "Signing in for prkit");
  await expect(signingIn.getByRole("link", "Open the sign-in page")).toHaveAttribute(
    "href",
    "http://127.0.0.1:9/cursor-stand-in-login",
    { timeout: 30_000 },
  );
  if (shots) await shoot(app, browser, "u68-cursor-signing-in");
  cursor.approveLogin();
  await expect(status).toHaveText("Signed in · Signed in for prkit, key good for 90 more days", {
    timeout: 30_000,
  });
  await expect(card.getByRole("button", "Sign out prkit's login")).toBeVisible();
  if (shots) await shoot(app, browser, "u68-cursor-signed-in");
  return card;
};

test(
  "Cursor: install its support, sign in, add a second one, pick it for a fix that runs no scripts, and fall back",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    // On the fake GitHub: the PR merges just before its turn starts, so the turn ends at once.
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const cursor = setUpFakeCursor(NAME);
    try {
      const run = startFakeInstance(NAME, fake, [
        "--claude",
        claude.file,
        "--e2e",
        "--cursor-manifest",
        cursor.manifest,
      ]);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await browser.addInitScript("window.open = () => null;");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });

      await installAndSignIn({ app, screen, browser }, cursor, true);
      // The SDK went into prkit's own folder, never next to the app.
      expect(
        NodeFS.existsSync(
          NodePath.join(run.home, "cursor-sdk", "1.0.37", "node_modules", "@cursor", "sdk"),
        ),
      ).toBe(true);

      // A second Cursor from the Add dialog: its own sign-in, which waits for a click.
      const list = await openAgents(screen, browser);
      await screen.getByRole("region", "Agents").getByRole("button", "Add agent").tap();
      const dialog = screen.getByRole("dialog", "Add agent");
      await dialog.getByRole("radio", /^Cursor/).tap();
      await shoot(app, browser, "u68-add-agent-kind");
      await dialog.getByRole("button", "Next").tap();
      await dialog.getByRole("textbox", "Label").fill("Side");
      await expect(dialog.getByRole("textbox", "Instance ID")).toHaveValue("cursor_side");
      await dialog.getByRole("button", "Next").tap();
      await dialog.getByRole("button", "Add and sign in").tap();
      await expect(dialog.getByRole("button", "Sign in with Cursor")).toBeVisible({
        timeout: 30_000,
      });
      await shoot(app, browser, "u68-add-agent-cursor");
      await dialog.getByRole("button", "Done").tap();
      const side = list.getByRole("listitem", "Side");
      await expect(side.getByRole("status")).toHaveText("Not signed in", { timeout: 30_000 });
      await side.getByRole("button", "Remove").tap();
      const remove = screen.getByRole("alertdialog", "Remove Side?");
      await expect(remove).toContainText(
        "prkit deletes its folder for it, with the Cursor key its sign-in saved there.",
      );
      await remove.getByRole("button", "Remove").tap();
      await expect(side).toHaveCount(0, { timeout: 30_000 });
      expect(NodeFS.existsSync(NodePath.join(run.home, "cursor-instances", "cursor_side"))).toBe(
        false,
      );

      // Send to agent on your own PR: Cursor's models sit with the other kinds', and picking
      // one says it runs no scripts, where any other agent would.
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/1?account=github.com%2Fbudget-test&tab=files`,
      );
      const file = screen.getByRole("region", "src/change-0.ts");
      await expect(file.getByRole("button", "Comment on line 1")).toBeVisible({ timeout: 30_000 });
      await file.getByRole("button", "Comment on line 1").tap();
      await screen.getByRole("textbox", "Comment on line 1").fill("Name the limit.");
      await screen.getByRole("textbox", "Comment on line 1").press("Meta+Enter");
      await screen.getByRole("button", "Review, 1 pending").first().tap();
      await screen
        .getByRole("group", "Where your comments go")
        .getByRole("button", "Send to agent")
        .tap();
      const send = screen.getByRole("dialog", "Send to agent");
      const notice = send.getByRole("status", "Check scripts");
      await expect(notice).toHaveText(
        "The agent may run this repository's test, lint and type check scripts: you opened it.",
        { timeout: 30_000 },
      );
      await send.getByRole("button", /^Agent and model: /).tap();
      await expect(screen.getByRole("option", /Stand-in 1/)).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("option", /Claude Sonnet 5\.5/).first()).toBeVisible();
      await shoot(app, browser, "u68-picker-three-kinds");
      await screen.getByRole("combobox", "Search models").fill("stand-in");
      await screen.getByRole("option", /Stand-in 1/).tap();
      await expect(notice).toHaveText(CURSOR_REASON);
      await fake.merge(1);
      await send.getByRole("button", "Send 1 comment to agent").tap();
      await screen.getByRole("button", "Open Fixes").tap({ timeout: 30_000 });
      const header = screen.getByRole("status", "Check scripts");
      await expect(header).toHaveText(CURSOR_REASON, { timeout: 30_000 });
      expect(readRows(run.home, "SELECT instance_id FROM fixers WHERE pr_key LIKE '%#1'")).toEqual([
        { instance_id: "cursor" },
      ]);
      await shoot(app, browser, "u68-fixes-header");
      await screen.getByRole("button", "Repository settings").tap();
      await expect(
        screen.getByRole(
          "switch",
          "Run check scripts on any pull request for github.com/budget/fixtures",
        ),
      ).toBeVisible();
      // The header's line, and the same reason under the scripts option.
      await expect(screen.getByText(CURSOR_REASON)).toHaveCount(2);
      await shoot(app, browser, "u68-repository-settings");
      await browser.keyboard.press("Escape");

      // Cursor off: the PR's next fix falls back to the default agent.
      const card = (await openAgents(screen, browser)).getByRole("listitem", "Cursor");
      await card.getByRole("switch", "Cursor on").tap();
      await expect(card.getByRole("status")).toHaveText("Off", { timeout: 30_000 });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`,
      );
      const other = screen.getByRole("region", "src/limits.ts");
      await expect(other.getByRole("button", "Comment on line 1")).toBeVisible({
        timeout: 30_000,
      });
      await other.getByRole("button", "Comment on line 1").tap();
      await screen.getByRole("textbox", "Comment on line 1").fill("Name the limit.");
      await screen.getByRole("textbox", "Comment on line 1").press("Meta+Enter");
      await screen.getByRole("button", "Review, 1 pending").first().tap();
      await screen
        .getByRole("group", "Where your comments go")
        .getByRole("button", "Send to agent")
        .tap();
      const fallback = screen.getByRole("dialog", "Send to agent");
      await expect(fallback.getByRole("button", /^Agent and model: Claude/)).toBeVisible({
        timeout: 30_000,
      });
      await fallback.getByRole("button", /^Agent and model: /).tap();
      await screen.getByRole("combobox", "Search models").fill("stand-in");
      await expect(screen.getByRole("option")).toHaveCount(0);
      await browser.keyboard.press("Escape");
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "Cursor: a guide and an edit-only fix on the fixture, with prkit's tools only",
  { skip: NEEDS_FIXTURE, timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const claude = setUpFakeClaude(`${NAME}-fixture`);
    const cursor = setUpFakeCursor(`${NAME}-fixture`);
    const fixture = createFixFixture(`${Date.now()}`);
    try {
      const run = startInstance(`${NAME}-fixture`, [
        "--claude",
        claude.file,
        "--e2e",
        "--cursor-manifest",
        cursor.manifest,
      ]);
      const home = NodePath.join(run.home, "cursor-instances", "cursor", "home");
      await browser.setViewport({ width: 1280, height: 860 });
      await browser.addInitScript("window.open = () => null;");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await installAndSignIn({ app, screen, browser }, cursor, false);

      // Every turn first tries to reach past the checkout through each of prkit's tools.
      cursor.probe(PROBE);

      // A guide on Cursor: none of Cursor's own tools, prkit's reading tools and its MCP tools
      // through the runner, none of the user's or the repository's settings, the sandbox on.
      await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "guide")}`);
      const setup = screen.getByRole("form", "Start a guide");
      await setup.getByRole("button", /^Agent and model: /).tap({ timeout: 60_000 });
      await screen.getByRole("combobox", "Search models").fill("stand-in");
      await screen.getByRole("option", /Stand-in 1/).tap();
      await setup.getByRole("button", "Generate guide").tap();
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });
      await expect(screen.getByLabel("Guide status")).toContainText("Stand-in 1");
      const guide = cursor.runs().at(-1);
      expect(guide).toMatchObject({
        tools: ["mcp_tool_call", "get_mcp_tools_tool_call"],
        mcpServers: [],
        customTools: [...READ_TOOLS, ...GUIDE_TOOLS].sort(),
        settingSources: [],
        sandbox: true,
        home,
        resumed: false,
      });
      expect(guide?.disallowedTools).toEqual(expect.arrayContaining(NEVER));
      const guideCalls = cursor.calls();
      expect(guideCalls.slice(0, PROBE.length).filter((call) => call.ok)).toEqual([]);
      expect(guideCalls.find((call) => call.tool === "read_file" && call.ok)).toBeDefined();

      // An edit-only fix on your own PR: the agent edits, prkit commits, nothing runs.
      await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "files")}`);
      await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
      await draftOn({ app, screen, browser }, 3, "Add a note.");
      await screen.getByRole("button", "Review, 1 pending").first().tap();
      await screen
        .getByRole("group", "Where your comments go")
        .getByRole("button", "Send to agent")
        .tap();
      const send = screen.getByRole("dialog", "Send to agent");
      await send.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("stand-in");
      await screen.getByRole("option", /Stand-in 1/).tap();
      await expect(send.getByRole("status", "Check scripts")).toHaveText(CURSOR_REASON);
      await send.getByRole("button", "Send 1 comment to agent").tap();
      await screen.getByRole("button", "Open Fixes").tap({ timeout: 30_000 });
      await expect(screen.getByRole("status", "Check scripts")).toHaveText(CURSOR_REASON, {
        timeout: 30_000,
      });
      const fixes = screen.getByRole("list", "Fixes");
      await expect(
        fixes.getByText(/^prkit committed \w+: Add the stand-in Cursor's note$/),
      ).toBeVisible({
        timeout: 120_000,
      });
      await expect(fixes.getByRole("region", "stand-in.md")).toBeVisible();
      const fix = cursor.runs().at(-1);
      expect(fix).toMatchObject({
        tools: ["mcp_tool_call", "get_mcp_tools_tool_call"],
        mcpServers: [],
        customTools: [...READ_TOOLS, "edit_file", "write_file", ...FIX_TOOLS].sort(),
        settingSources: [],
        sandbox: true,
        home,
      });
      expect(fix?.disallowedTools).toEqual(expect.arrayContaining(NEVER));
      expect(fix?.cwd).not.toBe(guide?.cwd);
      const fixCalls = cursor.calls().slice(guideCalls.length);
      expect(fixCalls.slice(0, PROBE.length).filter((call) => call.ok)).toEqual([]);
      const cwd = fix?.cwd ?? "";
      expect(NodeFS.existsSync(NodePath.join(NodePath.dirname(cwd), "escape.txt"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(cwd, ".cursor", "sandbox.json"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(cwd, "sandbox.json"))).toBe(false);
      expect(
        readRows(
          run.home,
          "SELECT json_extract(status, '$._tag') AS state FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
        ),
      ).toEqual([{ state: "ready" }]);
    } finally {
      stopFakeInstance(`${NAME}-fixture`, { keepHome: false });
      closeFixFixture(fixture);
    }
  },
);
