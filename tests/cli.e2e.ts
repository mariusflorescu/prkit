import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  FilesResult,
  ConversationResult,
  GuideSettingsResult,
} from "../apps/server/src/outside/paritySchemas.ts";
import { ResponseFragment } from "../apps/server/src/outside/responseSchemas.ts";
import { InboxListResult } from "../apps/server/src/outside/schemas.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { startBridge } from "./outsideBridge.ts";

const Json = Schema.fromJsonString(Schema.Json);

test("unsafe launcher folders leave startup running and explain both setup blocks", async ({
  app,
  screen,
}) => {
  const name = "u71-unsafe-launchers";
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const home = NodePath.join(repoRoot, ".e2e/homes", name);
  const directory = NodePath.join(fake.home, "foreign-bin");
  const bin = NodePath.join(home, "bin");
  const variables = {
    PRKIT_CLI_INSTALL_PATH: NodePath.join(fake.home, "local-bin/prkit"),
    CODEX_HOME: NodePath.join(fake.home, ".codex"),
    CLAUDE_CONFIG_DIR: NodePath.join(fake.home, ".claude"),
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.mkdirSync(directory);
    for (const command of ["prkit", "prkit-mcp"])
      NodeFS.writeFileSync(NodePath.join(directory, command), `${command} stays untouched\n`, {
        mode: 0o640,
      });
    NodeFS.symlinkSync(directory, bin);
    const run = startFakeInstance(name, fake, ["--claude", claude.file]);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", "Inbox")).toBeVisible();
    await app.open(`${run.url}/settings/outside-agents`);
    const problem = `prkit can't use ${bin}: its symlink isn't owned by root. Fix the folder, then restart prkit.`;
    await expect(screen.getByText(problem, { exact: true })).toHaveCount(2);
    await expect(
      screen.getByRole("button", "Install command line tool", { exact: true }),
    ).toBeDisabled();
    await app.screenshot("cli-unsafe-launcher-off");
    await screen.getByRole("switch", "Let my coding agents use prkit").tap();
    await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
    await expect(screen.getByText(problem, { exact: true })).toHaveCount(2);
    await expect(screen.getByText("Add prkit to your client", { exact: true })).toHaveCount(0);
    await app.screenshot("cli-unsafe-launcher-on");
    await screen.getByText(problem, { exact: true }).nth(1).scrollIntoView();
    await app.screenshot("cli-unsafe-launcher-mcp");
    expect(NodeFS.lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(run.home, "outside-agents.json"))).toBe(true);
    for (const command of ["prkit", "prkit-mcp"]) {
      const file = NodePath.join(directory, command);
      expect(NodeFS.readFileSync(file, "utf8")).toBe(`${command} stays untouched\n`);
      expect(NodeFS.statSync(file).mode & 0o777).toBe(0o640);
    }
    expect(await fake.writes()).toEqual([]);
  } finally {
    stopFakeInstance(name, { keepHome: false });
    fake.stop();
    for (const key of Object.keys(variables)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test(
  "the app installs its CLI safely and shell workflows use outside access",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "u71-cli";
    const fake = await startFakeGitHub(name);
    await fake.shape(1, { additions: 2 });
    await fake.shape(2, { additions: 400 });
    await fake.shape(3, { additions: 5000 });
    await fake.requestReview(3, { login: "budget-test" }, 5);
    const localGit = await cliFixture(fake);
    const claude = setUpFakeClaude(name);
    const install = NodePath.join(fake.home, "local-bin", "prkit");
    const terminal = NodePath.join(fake.home, "terminal");
    const terminalLog = NodePath.join(fake.home, "terminal-call.txt");
    const evidence = NodePath.join(repoRoot, ".e2e/evidence/u71");
    NodeFS.mkdirSync(evidence, { recursive: true });
    NodeFS.writeFileSync(terminal, `#!/bin/sh\nprintf '%s\\n' "$@" > '${terminalLog}'\n`, {
      mode: 0o700,
    });
    const variables = {
      PATH: localGit.path,
      PRKIT_CLI_INSTALL_PATH: install,
      PRKIT_TERMINAL_PATH: terminal,
      CODEX_HOME: NodePath.join(fake.home, ".codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(fake.home, ".claude"),
    };
    const previous = Object.fromEntries(
      Object.keys(variables).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, variables);
    const log: string[] = [];
    let bridge: ReturnType<typeof startBridge> | null = null;
    try {
      const run = startFakeInstance(name, fake, ["--claude", claude.file]);
      const launcher = NodePath.join(run.home, "bin/prkit");
      const cli = (args: string[]) => {
        const result = NodeChildProcess.spawnSync(launcher, args, {
          encoding: "utf8",
          env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
        });
        log.push(
          `$ prkit ${args.join(" ")}\nexit ${result.status}\n${result.stdout}${result.stderr}`,
        );
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      expect(NodeFS.statSync(launcher).mode & 0o777).toBe(0o700);
      expect(NodeFS.readFileSync(launcher, "utf8")).toContain("cli");
      expect(cli(["--version"]).code).toBe(0);
      expect(cli(["guide", "generate", "--help"]).stdout).toContain("--option");
      expect(cli(["--completions", "zsh"]).code).toBe(0);
      expect(cli(["wait", "budget/fixtures#9", "--for", "bad"]).code).toBe(2);
      for (const args of [
        ["--stack", "1", "--stack", "2"],
        ["--stack", "1,2", "--layers", "3"],
      ]) {
        const rejected = cli(["guide", "generate", "budget/fixtures#9", ...args]);
        expect(rejected.code).toBe(2);
        expect(rejected.stderr).toContain("Use --stack once:");
      }
      expect(cli(["status"]).code).toBe(3);
      expect(cli(["not-a-command"]).code).toBe(2);
      const lockBefore = NodeFS.statSync(NodePath.join(run.home, "prkit.lock")).mtimeMs;
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await browser.keyboard.press("Meta+Comma");
      await screen.getByRole("link", "Outside agents").tap();
      await expect(screen.getByText("Not installed", { exact: true })).toBeVisible();
      await app.screenshot("cli-before-install");
      await screen.getByRole("button", "Install command line tool", { exact: true }).tap();
      await expect(screen.getByRole("button", "Uninstall command line tool")).toBeVisible();
      expect(NodeFS.readlinkSync(install)).toBe(launcher);
      await expect(screen.getByText("Installed · Not on PATH", { exact: true })).toBeVisible();
      await app.screenshot("cli-installed-not-on-path");
      await screen.getByRole("button", "Open skill installer in Terminal").tap();
      await expect(screen.getByText("Skill installer opened in Terminal")).toBeVisible();
      const terminalCall = NodeFS.readFileSync(terminalLog, "utf8");
      expect(terminalCall).toContain("npx skills@1.7.2 add https://github.com/");
      expect(terminalCall).toContain("/tree/main/skills --skill prkit-cli");
      log.push(`Terminal stand-in:\n${terminalCall}`);
      // The application writes no skill files and never runs the installer itself.
      expect(NodeFS.existsSync(NodePath.join(fake.home, ".agents/skills/prkit-cli"))).toBe(false);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
      const status = cli(["status", "--json"]);
      expect(status.code).toBe(0);
      if (process.env.PRKIT_E2E_CLI_SANDBOX === "1") {
        NodeFS.mkdirSync(NodePath.join(fake.home, "sandbox-codex"), { recursive: true });
        for (const network of [false, true]) {
          const result = NodeChildProcess.spawnSync(
            "codex",
            [
              "-c",
              'sandbox_mode="workspace-write"',
              "-c",
              `sandbox_workspace_write.network_access=${network}`,
              "sandbox",
              launcher,
              "status",
              "--json",
            ],
            {
              encoding: "utf8",
              timeout: 20_000,
              env: {
                HOME: fake.home,
                CODEX_HOME: NodePath.join(fake.home, "sandbox-codex"),
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                NO_COLOR: "1",
              },
            },
          );
          const output = `codex sandbox, network_access=${network}\nexit ${result.status}\n${result.stdout}${result.stderr}`;
          NodeFS.writeFileSync(NodePath.join(evidence, `sandbox-network-${network}.txt`), output);
          log.push(output);
          expect(result.status).toBe(network ? 0 : 3);
        }
      }
      const match = NodeChildProcess.spawnSync(
        "pgrep",
        ["-f", "LeagueofLegends.app/Contents/MacOS/LeagueofLegends"],
        { encoding: "utf8" },
      );
      const load = NodeOS.loadavg()[0] ?? 100;
      if (match.status === 1 && load < 10) {
        const uptime = NodeChildProcess.execFileSync("uptime", { encoding: "utf8" }).trim();
        const start = performance.now();
        const measured = cli(["status", "--json"]);
        const duration = performance.now() - start;
        expect(measured.code).toBe(0);
        NodeFS.writeFileSync(
          NodePath.join(evidence, "status-timing.txt"),
          `${uptime}\n1-minute load: ${load}\nprkit status --json wall time: ${duration.toFixed(1)} ms\n`,
        );
      } else
        NodeFS.writeFileSync(
          NodePath.join(evidence, "status-timing.txt"),
          `Deferred: active match or high load (${load}).\n`,
        );
      const inbox = cli(["inbox", "--json"]);
      expect(inbox.code).toBe(0);
      for (const reason of ["review-requested", "authored"]) {
        const filtered = cli(["inbox", "--reason", reason, "--repo", "budget/fixtures", "--json"]);
        expect(filtered.code).toBe(0);
        const result = Schema.decodeSync(Schema.fromJsonString(InboxListResult))(filtered.stdout);
        expect(result.total).toBeGreaterThan(0);
        expect(
          result.accounts
            .flatMap((entry) => entry.sections)
            .every((section) => section.reason === reason),
        ).toBe(true);
      }
      bridge = startBridge(run.home);
      await bridge.initialize();
      const direct = await bridge.call("list_inbox");
      expect("json" in direct ? direct.json : null).toEqual(Schema.decodeSync(Json)(inbox.stdout));
      const reviewOrder = (stdout: string) =>
        Schema.decodeSync(Schema.fromJsonString(InboxListResult))(stdout)
          .accounts.flatMap((entry) => entry.sections)
          .filter((section) => section.reason === "review-requested")
          .flatMap((section) => section.pullRequests.map((pr) => pr.key.split("#")[1]));
      expect(reviewOrder(inbox.stdout)).toEqual(["3", "1", "2"]);
      for (const [sort, order] of [
        ["waiting", ["1", "2", "3"]],
        ["size", ["1", "2", "3"]],
        ["updated", ["3", "1", "2"]],
      ] as const) {
        const sorted = cli(["inbox", "--sort", sort, "--json"]);
        expect(sorted.code).toBe(0);
        expect(reviewOrder(sorted.stdout)).toEqual(order);
        const viaBridge = await bridge.call("list_inbox", { sort });
        expect("json" in viaBridge ? viaBridge.json : null).toEqual(
          Schema.decodeSync(Json)(sorted.stdout),
        );
      }
      const waiting = Schema.decodeSync(Schema.fromJsonString(InboxListResult))(
        cli(["inbox", "--sort", "waiting", "--json"]).stdout,
      );
      const asked = waiting.accounts
        .flatMap((entry) => entry.sections.flatMap((section) => section.pullRequests))
        .find((pr) => pr.key.endsWith("#3"));
      expect(asked?.wait).toMatchObject({
        _tag: "waiting",
        cause: "requested-again",
        atLeast: false,
      });
      expect(asked?.size).toMatchObject({ bucket: "XL", lines: 5000, files: 1 });
      expect(cli(["inbox", "--sort", "newest"]).code).toBe(2);
      const account = Schema.decodeSync(
        Schema.fromJsonString(
          Schema.Struct({ accounts: Schema.Array(Schema.Struct({ accountId: Schema.String })) }),
        ),
      )(status.stdout).accounts[0]?.accountId;
      expect(account).toBeDefined();
      expect(cli(["inbox", "--account", account ?? "", "--json"]).code).toBe(0);
      expect(cli(["agents", "--json"]).code).toBe(0);
      expect(
        cli(["repos", "prs", "budget/fixtures", "--account", account ?? "", "--json"]).code,
      ).toBe(0);
      await fake.push(1);
      const firstFiles = cli(["pr", "files", "budget/fixtures#1", "--limit", "1", "--json"]);
      expect(firstFiles.code).toBe(0);
      const firstPage = Schema.decodeSync(Schema.fromJsonString(FilesResult))(firstFiles.stdout);
      expect(firstPage.items.length).toBe(1);
      if (firstPage.nextCursor === null) throw new Error("Expected another file page.");
      const directFiles = await bridge.call("read_pull_request_files", {
        owner: "budget",
        repo: "fixtures",
        number: 1,
        limit: 1,
      });
      expect("json" in directFiles ? directFiles.json : null).toEqual(
        Schema.decodeSync(Json)(firstFiles.stdout),
      );
      const secondFiles = cli([
        "pr",
        "files",
        "budget/fixtures#1",
        "--limit",
        "1",
        "--cursor",
        firstPage.nextCursor,
        "--json",
      ]);
      expect(secondFiles.code).toBe(0);
      const secondPage = Schema.decodeSync(Schema.fromJsonString(FilesResult))(secondFiles.stdout);
      expect(secondPage.items.length).toBe(1);
      expect(secondPage.items[0]?.path).not.toBe(firstPage.items[0]?.path);
      expect(secondPage.nextCursor).toBe(null);
      const readableFiles = cli(["pr", "files", "--limit", "1", "--", "budget/fixtures#1"]);
      expect(readableFiles.code).toBe(0);
      expect(readableFiles.stdout).toContain("prkit pr files");
      expect(readableFiles.stdout).toContain("--cursor");
      const nextFiles = readableFiles.stdout.split("\n").find((line) => line.startsWith("prkit "));
      if (nextFiles === undefined) throw new Error("Expected a next-page command.");
      expect(nextFiles.indexOf("--cursor")).toBeLessThan(nextFiles.indexOf(" -- "));
      const continued = NodeChildProcess.spawnSync("/bin/sh", ["-c", nextFiles], {
        cwd: fake.home,
        encoding: "utf8",
        env: {
          HOME: fake.home,
          PATH: `${NodePath.dirname(install)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          PRKIT_CLI_INSTALL_PATH: install,
          NO_COLOR: "1",
        },
      });
      log.push(`$ ${nextFiles}\nexit ${continued.status}\n${continued.stdout}${continued.stderr}`);
      expect(continued.status).toBe(0);
      const nextPath = secondPage.items[0]?.path;
      if (nextPath === undefined) throw new Error("Expected a second file.");
      expect(continued.stdout).toContain(nextPath);
      await fake.comment(9, 12_000);
      let response = Schema.decodeSync(Schema.fromJsonString(ResponseFragment))(
        cli(["pr", "conversation", "budget/fixtures#9", "--limit", "100", "--json"]).stdout,
      );
      let reconstructed = "";
      while (true) {
        expect(response.offset).toBe(reconstructed.length);
        reconstructed += response.text;
        if (response.nextResponseCursor === null) break;
        const fragment = cli([
          "pr",
          "conversation",
          "budget/fixtures#9",
          "--limit",
          "100",
          "--response-cursor",
          response.nextResponseCursor,
          "--json",
        ]);
        expect(fragment.code).toBe(0);
        response = Schema.decodeSync(Schema.fromJsonString(ResponseFragment))(fragment.stdout);
      }
      const conversation = Schema.decodeSync(Schema.fromJsonString(ConversationResult))(
        reconstructed,
      );
      expect(conversation.items.some((item) => item.body.length > 48_000)).toBe(true);
      expect(cli(["pr", "open", "budget/fixtures#9"]).code).toBe(4);
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      expect(cli(["pr", "open", "budget/fixtures#9", "--no-focus", "--json"]).code).toBe(0);
      expect(cli(["pr", "read", "https://github.com/budget/fixtures/pull/9", "--json"]).code).toBe(
        0,
      );
      const settings = cli(["guide", "settings", "budget/fixtures#9", "--json"]);
      expect(settings.code).toBe(0);
      const scope = Schema.decodeSync(Schema.fromJsonString(GuideSettingsResult))(settings.stdout)
        .scopes.pullRequest;
      expect(
        cli([
          "guide",
          "generate",
          "budget/fixtures#9",
          "--agent",
          "claude",
          "--model",
          "claude-sonnet-5-5",
          "--option",
          "effort=high",
          "--stack",
          "this",
          "--guidance",
          JSON.stringify({
            expectedVersion: scope.guidance.version,
            text: "Explain the limit change.",
            mode: "append",
          }),
          "--focus",
          JSON.stringify({
            expectedVersion: scope.focus.version,
            areas: [{ id: null, label: "Limit", question: "Is the limit safe?" }],
            overrides: [],
          }),
          "--json",
        ]).code,
      ).toBe(0);
      expect(
        cli(["wait", "budget/fixtures#9", "--for", "guide", "--timeout", "60", "--json"]).code,
      ).toBe(0);
      const guide = cli(["guide", "read", "budget/fixtures#9", "--json"]);
      expect(guide.code).toBe(0);
      expect(guide.stdout).toContain("A guide written by the stand-in agent.");
      expect(
        cli([
          "comments",
          "add",
          "budget/fixtures#9",
          "--path",
          "src/limits.ts",
          "--line",
          "2",
          "--body",
          "Name the limit.",
          "--request-id",
          "cli-comment",
          "--json",
        ]).code,
      ).toBe(0);
      expect(
        cli(["fix", "send", "budget/fixtures#9", "--request-id", "cli-send", "--json"]).code,
      ).toBe(0);
      expect(
        cli(["wait", "budget/fixtures#9", "--for", "fix", "--timeout", "60", "--json"]).code,
      ).toBe(0);
      const fixed = cli(["fix", "read", "budget/fixtures#9", "--json"]);
      expect(fixed.stdout).toContain("prkit CLI");
      expect(fixed.stdout).toContain('"waitingForPush":true');
      expect(NodeFS.statSync(NodePath.join(run.home, "prkit.lock")).mtimeMs).toBe(lockBefore);
      await screen.getByRole("button", "Uninstall command line tool").tap();
      await expect(screen.getByText("Not installed", { exact: true })).toBeVisible();
      expect(NodeFS.existsSync(install)).toBe(false);
      await browser.keyboard.press("Meta+k");
      await screen.getByRole("searchbox", "Find a pull request").fill("Install command line tool");
      await browser.keyboard.press("Enter");
      await expect(screen.getByRole("button", "Uninstall command line tool")).toBeVisible();
      expect(NodeFS.readlinkSync(install)).toBe(launcher);
      await screen.getByRole("button", "Uninstall command line tool").tap();
      await expect(screen.getByText("Not installed", { exact: true })).toBeVisible();
      NodeFS.writeFileSync(install, "foreign command\n");
      await screen.getByRole("button", "Check again").tap();
      await expect(screen.getByText("Another file uses this location")).toBeVisible();
      await expect(
        screen.getByRole("button", "Install command line tool", { exact: true }),
      ).toBeDisabled();
      expect(NodeFS.readFileSync(install, "utf8")).toBe("foreign command\n");
      await app.screenshot("cli-foreign-file-preserved");
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents are off", { exact: true })).toBeVisible();
      expect(cli(["status"]).code).toBe(3);
      expect(await fake.writes()).toEqual([]);
      log.push("Fake GitHub writes: []");
      await bridge.stop();
      bridge = null;
      stopFakeInstance(name, { keepHome: true });
      expect(cli(["status"]).code).toBe(3);
    } finally {
      NodeFS.writeFileSync(NodePath.join(evidence, "cli-transcript.txt"), log.join("\n\n"));
      await bridge?.stop();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      for (const key of Object.keys(variables)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  },
);
