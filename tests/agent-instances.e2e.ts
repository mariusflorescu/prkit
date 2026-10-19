import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";

import { repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  startFakeGitHub,
  startFakeInstance,
  startInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { FIXTURE_NAME, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const NAME = "agent-instances";
const PR = /#1 Validate links and count clicks/;

const modifierOf = (browser: Browser) =>
  browser.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));

/** Light and dark, once every open dialog and toast has faded in. */
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
  return screen.getByRole("region", "Agents");
};

const openGuide = async (screen: Screen) => {
  await screen.getByRole("navigation", "Workspace tabs").getByRole("link", PR).tap();
  await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
};

/** Adds a Claude Code instance through the three steps of the Add dialog. */
const addClaude = async (screen: Screen, label: string, folder: string) => {
  await screen.getByRole("region", "Agents").getByRole("button", "Add agent").tap();
  const dialog = screen.getByRole("dialog", "Add agent");
  await dialog.getByRole("radio", /^Claude Code/).tap();
  await dialog.getByRole("button", "Next").tap();
  await dialog.getByRole("textbox", "Label").fill(label);
  await dialog.getByRole("button", "Next").tap();
  await dialog.getByRole("textbox", "Config folder (CLAUDE_CONFIG_DIR)").fill(folder);
  await dialog.getByRole("button", "Add agent").tap();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
};

/** Picks a model of one instance in the Guide's setup, then starts the guide with `submit`. */
const generateOn = async (screen: Screen, instance: string, submit: string) => {
  const setup = screen.getByRole("form", "Start a guide");
  await setup.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
  await screen.getByRole("combobox", "Search models").fill(instance);
  await screen.getByRole("option", /Claude Sonnet 5\.5/).tap();
  await setup.getByRole("button", submit).tap();
};

test(
  "agent instances: add a second Claude, write a guide on it, switch, edit, turn off and remove",
  { skip: NEEDS_FIXTURE, timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const claude = setUpFakeClaude(NAME);
    // The second instance's config folder, where the stand-in saves its sessions.
    const work = NodePath.join(repoRoot, ".e2e", "fake", `${NAME}-work`);
    NodeFS.rmSync(work, { recursive: true, force: true });
    NodeFS.mkdirSync(work, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(work, "fake-plan"), "pro");
    const run = startInstance(NAME, ["--claude", claude.file]);
    const review = () =>
      readRows(
        run.home,
        "SELECT instance_id, session_id FROM reviews WHERE pr_key LIKE '%#1' ORDER BY created_at DESC LIMIT 1",
      )[0];
    const lastRun = () => claude.runs().at(-1);
    try {
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await app.open(run.openUrl);
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
      await screen.getByRole("region", "Yours").getByRole("link", PR).tap({ timeout: 45_000 });

      // The Add dialog: each step, and what it says when Next can't go on.
      const agents = await openAgents(screen, browser);
      const list = agents.getByRole("list", "Agents");
      await expect(list.getByRole("listitem", "Claude")).toBeVisible({ timeout: 30_000 });
      await agents.getByRole("button", "Add agent").tap();
      const dialog = screen.getByRole("dialog", "Add agent");
      await expect(dialog.getByRole("radio", /^Claude Code/)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await shoot(app, browser, "u67-add-agent-kind");
      await dialog.getByRole("button", "Next").tap();
      await expect(dialog.getByRole("textbox", "Instance ID")).toHaveValue("claude_2");
      await dialog.getByRole("textbox", "Label").fill("Work");
      await expect(dialog.getByRole("textbox", "Instance ID")).toHaveValue("claude_work");
      await dialog.getByRole("textbox", "Instance ID").fill("claude");
      await dialog.getByRole("button", "Next").tap();
      await expect(dialog.getByRole("alert")).toHaveText(
        "An instance named 'claude' already exists.",
      );
      await shoot(app, browser, "u67-add-agent-name-error");
      await dialog.getByRole("textbox", "Instance ID").fill("claude_work");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await shoot(app, browser, "u67-add-agent-name");
      await dialog.getByRole("button", "Next").tap();
      const folder = dialog.getByRole("textbox", "Config folder (CLAUDE_CONFIG_DIR)");
      await folder.fill("claude-work");
      await dialog.getByRole("button", "Add agent").tap();
      await expect(dialog.getByRole("alert")).toHaveText("Use a full path, starting with / or ~/.");
      await shoot(app, browser, "u67-add-agent-setup-error");
      await folder.fill(work);
      await dialog.getByRole("button", "Add agent").tap();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      const added = list.getByRole("listitem", "Work");
      await expect(added).toHaveAttribute("data-instance", "claude_work");
      await expect(added.getByRole("status", "Work status")).toHaveText(
        "Signed in · Claude Pro subscription",
        { timeout: 30_000 },
      );
      await expect(list.getByRole("listitem", "Claude").getByRole("status")).toHaveText(
        "Signed in · Claude Max subscription",
      );
      await shoot(app, browser, "u67-agents-list");

      // The pickers group by instance and say which one is picked.
      await openGuide(screen);
      const setup = screen.getByRole("form", "Start a guide");
      await setup.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("sonnet");
      await expect(screen.getByRole("option", /Claude Sonnet 5\.5/)).toHaveCount(2);
      await shoot(app, browser, "u67-picker-two-claudes");
      await browser.keyboard.press("Escape");

      // A guide on the new instance runs with its config folder.
      await generateOn(screen, "claude_work", "Generate guide");
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });
      await expect(screen.getByLabel("Guide status")).toContainText(
        "Claude Sonnet 5.5 · High · Work",
      );
      expect(lastRun()).toMatchObject({ configDir: work, resumed: false });
      const first = review();
      expect(first?.instance_id).toBe("claude_work");
      expect(NodeFS.readdirSync(NodePath.join(work, "projects"))).toHaveLength(1);

      // Another instance on the same folder keeps the conversation.
      await openAgents(screen, browser);
      await addClaude(screen, "Same", work);
      await openGuide(screen);
      await screen.getByRole("button", "Generate again with other settings").tap();
      await generateOn(screen, "claude_same", "Generate again");
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2 · ", {
        timeout: 90_000,
      });
      expect(lastRun()).toMatchObject({
        configDir: work,
        session: first?.session_id,
        resumed: true,
      });
      expect(review()).toMatchObject({ instance_id: "claude_same", session_id: first?.session_id });

      // Edit in place: label and accent.
      await openAgents(screen, browser);
      await list.getByRole("listitem", "Work").getByRole("button", "Edit").tap();
      const edit = screen.getByRole("form", "Edit Work");
      await edit.getByRole("textbox", "Label").fill("Day job");
      await edit.getByLabel("Accent").fill("#2f7d6d");
      await shoot(app, browser, "u67-edit-agent");
      await edit.getByRole("button", "Save").tap();
      await expect(screen.getByText("Saved Day job")).toBeVisible({ timeout: 30_000 });
      await expect(list.getByRole("listitem", "Day job")).toHaveAttribute(
        "data-instance",
        "claude_work",
      );
      expect(
        readRows(run.home, "SELECT label, accent FROM agent_instances WHERE id = 'claude_work'"),
      ).toEqual([{ label: "Day job", accent: "#2f7d6d" }]);

      // Off: gone from the pickers, and the PR moves to Claude's default instance with a new
      // conversation, since that one keeps its sessions in another folder.
      await list.getByRole("switch", "Same on").tap();
      await expect(list.getByRole("listitem", "Same").getByRole("status")).toHaveText("Off");
      await openGuide(screen);
      await screen.getByRole("button", "Generate again with other settings").tap();
      const fallback = screen.getByRole("form", "Start a guide");
      await expect(
        fallback.getByRole("button", "Agent and model: Claude Sonnet 5.5 · Claude"),
      ).toBeVisible({ timeout: 30_000 });
      await fallback.getByRole("button", /^Agent and model: /).tap();
      await screen.getByRole("combobox", "Search models").fill("sonnet");
      await expect(screen.getByRole("option", /Claude Sonnet 5\.5/)).toHaveCount(2);
      await screen.getByRole("combobox", "Search models").fill("claude_same");
      await expect(screen.getByRole("option")).toHaveCount(0);
      await browser.keyboard.press("Escape");
      await fallback.getByRole("button", "Generate again").tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r3 · ", {
        timeout: 90_000,
      });
      // The default Claude keeps the folder the server was started with, if any.
      expect(lastRun()).toMatchObject({
        configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
        resumed: false,
      });
      expect(review()?.instance_id).toBe("claude");
      expect(review()?.session_id).not.toBe(first?.session_id);

      // Remove asks first, and leaves the config folder alone.
      await openAgents(screen, browser);
      await list.getByRole("listitem", "Day job").getByRole("button", "Remove").tap();
      const confirm = screen.getByRole("alertdialog", "Remove Day job?");
      await expect(confirm).toContainText(
        "Its config folder and Claude Code login stay as they are.",
      );
      await shoot(app, browser, "u67-remove-agent");
      await confirm.getByRole("button", "Remove").tap();
      await expect(confirm).toBeHidden({ timeout: 30_000 });
      await expect(list.getByRole("listitem", "Day job")).toHaveCount(0, { timeout: 30_000 });
      expect(readRows(run.home, "SELECT id FROM agent_instances ORDER BY id")).toEqual([
        { id: "claude_same" },
      ]);
      expect(NodeFS.existsSync(NodePath.join(work, "projects"))).toBe(true);
      // A default instance can be reset, never removed.
      await expect(list.getByRole("listitem", "Claude").getByRole("button", "Remove")).toHaveCount(
        0,
      );

      // A Codex instance's prkit home goes with it.
      await agents.getByRole("button", "Add agent").tap();
      await dialog.getByRole("radio", /^Codex, set up by hand/).tap();
      await dialog.getByRole("button", "Next").tap();
      await dialog.getByRole("textbox", "Label").fill("Side");
      await dialog.getByRole("button", "Next").tap();
      await dialog.getByRole("textbox", "Codex home (CODEX_HOME)").fill(work);
      await dialog.getByRole("button", "Add agent").tap();
      const side = list.getByRole("listitem", "Side");
      await expect(side.getByRole("status")).not.toHaveText("Checking…", { timeout: 30_000 });
      const sideHome = NodePath.join(run.home, "codex-instances", "codex_side");
      NodeFS.mkdirSync(sideHome, { recursive: true });
      await side.getByRole("button", "Remove").tap();
      const removeSide = screen.getByRole("alertdialog", "Remove Side?");
      await removeSide.getByRole("button", "Remove").tap();
      await expect(removeSide).toBeHidden({ timeout: 30_000 });
      await expect(side).toHaveCount(0);
      expect(NodeFS.existsSync(sideHome)).toBe(false);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      NodeFS.rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  "agent instances: the Fixes header names the instance, and Codex signs in with ChatGPT for one",
  { timeout: 180_000 },
  async ({ app, screen, browser }) => {
    // On the fake GitHub: the PR merges just before its turn starts, so the turn ends at once,
    // and the ChatGPT sign-in stops at its page, which is never opened.
    const fake = await startFakeGitHub(`${NAME}-fixes`);
    const claude = setUpFakeClaude(`${NAME}-fixes`);
    const work = NodePath.join(repoRoot, ".e2e", "fake", `${NAME}-fixes-work`);
    NodeFS.rmSync(work, { recursive: true, force: true });
    NodeFS.mkdirSync(work, { recursive: true });
    try {
      const run = startFakeInstance(`${NAME}-fixes`, fake, ["--claude", claude.file]);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await browser.addInitScript("window.open = () => null;");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      await openAgents(screen, browser);
      await expect(screen.getByRole("list", "Agents").getByRole("listitem", "Claude")).toBeVisible({
        timeout: 30_000,
      });
      await addClaude(screen, "Work", work);

      // A sensitive variable: kept by the server, never sent back, and kept when left blank.
      const card = screen.getByRole("list", "Agents").getByRole("listitem", "Work");
      await card.getByRole("button", "Edit").tap();
      const edit = screen.getByRole("form", "Edit Work");
      await edit.getByRole("button", "Add variable").tap();
      await expect(edit).toContainText(
        "Claude Code passes these to commands it runs; on trusted fixes the repository's check scripts can read them.",
      );
      await edit.getByRole("textbox", "Variable 1 name").fill("ANTHROPIC_API_KEY");
      await edit.getByRole("button", "Save").tap();
      await expect(edit.getByRole("alert")).toContainText("off your subscription");
      await edit.getByRole("textbox", "Variable 1 name").fill("CLAUDE_CODE_SHELL_PREFIX");
      await expect(edit.getByRole("alert")).toContainText("changes how the agent runs");
      await edit.getByRole("textbox", "Variable 1 name").fill("STAND_IN_TOKEN");
      await edit.getByRole("button", "Mark as sensitive").tap();
      await edit.getByLabel("Variable 1 value").fill("stand-in-secret-7f3a");
      await edit.getByRole("button", "Save").tap();
      await expect(screen.getByText("Saved Work")).toBeVisible({ timeout: 30_000 });
      await card.getByRole("button", "Edit").tap();
      // The page holds no value to show: the field is empty, with a note in its place.
      await expect
        .poll(() =>
          browser.evaluate(() => {
            const field = document.querySelector('input[aria-label="Variable 1 value"]');
            return field instanceof HTMLInputElement
              ? { value: field.value, placeholder: field.placeholder }
              : null;
          }),
        )
        .toEqual({ value: "", placeholder: "Saved. Type to replace it." });
      await shoot(app, browser, "u67-edit-agent-secret");
      // Unlocking a saved secret asks for it again rather than dropping it; locking keeps it.
      await edit.getByRole("button", "Sensitive: stored apart").tap();
      await expect(edit).toContainText("Lock it again to keep the saved one.");
      await edit.getByRole("button", "Save").tap();
      await expect(edit.getByRole("alert")).toHaveText(
        "STAND_IN_TOKEN: Type the value again: prkit never shows a saved sensitive value.",
      );
      await shoot(app, browser, "u67-edit-agent-unlocked-secret");
      await edit.getByRole("button", "Mark as sensitive").tap();
      await expect(edit.getByRole("alert")).toHaveCount(0);
      await edit.getByRole("textbox", "Label").fill("Work ");
      await edit.getByRole("button", "Save").tap();
      await expect(screen.getByText("Saved Work").first()).toBeVisible({ timeout: 30_000 });
      const [stored] = readRows(
        run.home,
        "SELECT environment FROM agent_instances WHERE id = 'claude_work'",
      );
      expect(JSON.stringify(stored)).not.toContain("stand-in-secret-7f3a");
      expect(NodeFS.readFileSync(NodePath.join(run.home, "agent-secrets.json"), "utf8")).toContain(
        "stand-in-secret-7f3a",
      );

      // A fix sent to the second instance: the Fixes header says which one.
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`,
      );
      const file = screen.getByRole("region", "src/limits.ts");
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
      await send.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("claude_work");
      await screen.getByRole("option", /Claude Sonnet 5\.5/).tap();
      await expect(send.getByRole("button", /^Agent and model: .* · Work$/)).toBeVisible();
      await fake.merge(9);
      await send.getByRole("button", "Send 1 comment to agent").tap();
      await screen.getByRole("button", "Open Fixes").tap({ timeout: 30_000 });
      await expect(screen.getByText(/Claude Sonnet 5\.5 · .*Work/).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(readRows(run.home, "SELECT instance_id FROM fixers WHERE pr_key LIKE '%#9'")).toEqual([
        { instance_id: "claude_work" },
      ]);
      await shoot(app, browser, "u67-fixes-header");

      // Sign in with ChatGPT: a Codex instance holding a login of its own, signing in at once.
      await openAgents(screen, browser);
      await screen.getByRole("region", "Agents").getByRole("button", "Add agent").tap();
      const dialog = screen.getByRole("dialog", "Add agent");
      await dialog.getByRole("radio", /^Sign in with ChatGPT/).tap();
      await dialog.getByRole("button", "Next").tap();
      await expect(dialog.getByRole("textbox", "Account name")).toHaveValue("Personal");
      await expect(dialog.getByRole("textbox", "Instance ID")).toHaveValue("codex_personal");
      await dialog.getByRole("button", "Next").tap();
      await shoot(app, browser, "u67-add-agent-chatgpt");
      await dialog.getByRole("button", "Add and sign in").tap();
      const signingIn = dialog.getByRole("status", "Signing in for prkit");
      await expect(signingIn.getByRole("link", "Open the sign-in page")).toHaveAttribute(
        "href",
        /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/,
        { timeout: 30_000 },
      );
      await shoot(app, browser, "u67-add-agent-chatgpt-signing-in");
      await signingIn.getByRole("button", "Cancel").tap();
      await dialog.getByRole("button", "Done").tap();
      const personal = screen.getByRole("list", "Agents").getByRole("listitem", "Personal");
      await expect(personal.getByRole("status")).toHaveText("Not signed in", { timeout: 30_000 });
      const home = NodePath.join(run.home, "codex-instances", "codex_personal");
      expect(NodeFS.existsSync(NodePath.join(home, "config.toml"))).toBe(true);
      await personal.getByRole("button", "Remove").tap();
      const confirm = screen.getByRole("alertdialog", "Remove Personal?");
      await expect(confirm).toContainText(
        "prkit signs out the ChatGPT login it holds for it, then deletes its folder. If Codex can't confirm the sign-out, nothing is removed.",
      );
      await confirm.getByRole("button", "Remove").tap();
      // This instance's HOME is a stand-in with no keychain, so Codex can't say the login is
      // signed out: the removal is refused and the home kept, as it must be.
      await expect(confirm.getByRole("alert")).toHaveText(
        "prkit couldn't confirm Personal's ChatGPT login is signed out, so it kept the agent.",
        { timeout: 30_000 },
      );
      await shoot(app, browser, "u67-remove-agent-unconfirmed");
      expect(NodeFS.existsSync(NodePath.join(home, "config.toml"))).toBe(true);
      await confirm.getByRole("button", "Cancel").tap();
      await expect(personal).toBeVisible();
    } finally {
      stopFakeInstance(`${NAME}-fixes`, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(work, { recursive: true, force: true });
    }
  },
);
