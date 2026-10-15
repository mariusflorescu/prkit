import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  startFakeGitHub,
  startFakeInstance,
  startInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { type Fixtures } from "./fixActions.ts";
import { FIXTURE_ACCOUNT, FIXTURE_REPO, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { type Bridge, startBridge } from "./outsideBridge.ts";

const READS = [
  "list_inbox",
  "list_open_pull_requests",
  "list_review_comments",
  "prkit_status",
  "read_fix",
  "read_guide",
  "read_pull_request",
  "wait_for",
];
const ALL = [
  ...READS,
  "add_review_comment",
  "ask_fix_agent_to_change",
  "generate_guide",
  "open_pull_request",
  "resolve_conflicts",
  "retry_fix",
  "send_to_fix_agent",
  "stop_fix",
  "stop_guide",
].sort();
const NOT_OPEN = "prkit isn't open. Open it, then try again.";
const OFF = "Outside agents are off. Turn them on in prkit > Settings > Outside agents.";
const CLIENT = "e2e client";
const PR_9 = "https://github.com/budget/fixtures/pull/9";

const Discovery = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.Literal("on"), port: Schema.Number, token: Schema.String }),
);

/** Every call and answer of a journey, kept as evidence under `.e2e/evidence/u69/`. */
const transcript = (name: string) => {
  const lines: string[] = [];
  return {
    note: (what: string, value: object | string) =>
      lines.push(
        `## ${what}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
      ),
    save: () => {
      const dir = NodePath.join(repoRoot, ".e2e", "evidence", "u69");
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, `${name}.md`), `${lines.join("\n\n")}\n`);
    },
  };
};

/** Settings > Outside agents, through Cmd+, and the section nav. */
const openOutsideSettings = async ({ screen, browser }: Fixtures) => {
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("link", "Outside agents").tap();
  await expect(screen.getByRole("switch", "Let my coding agents use prkit")).toBeVisible({
    timeout: 20_000,
  });
};

const switchOn = async ({ screen }: Fixtures, on: boolean) => {
  const toggle = screen.getByRole("switch", "Let my coding agents use prkit");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-checked", on ? "true" : "false", { timeout: 15_000 });
  await expect(
    screen.getByText(on ? "Outside agents can read" : "Outside agents are off"),
  ).toBeVisible({
    timeout: 15_000,
  });
};

/** Tools the bridge lists, once they settle on `expected`. The bridge reads the file every 2s. */
const toolsSettle = (bridge: Bridge, expected: ReadonlyArray<string>) =>
  expect.poll(() => bridge.tools(), { timeout: 20_000, interval: 1_000 }).toEqual(expected);

const statusSettles = (bridge: Bridge, text: string | null) =>
  expect
    .poll(
      async () => {
        const answer = await bridge.call("prkit_status");
        return "text" in answer && answer.isError ? answer.text : null;
      },
      { timeout: 30_000, interval: 1_000 },
    )
    .toBe(text);

/** A request straight to the endpoint, as only the bridge should make it. `fetch` can't set Host. */
const raw = (home: string, headers: Record<string, string>) => {
  const file = Schema.decodeUnknownSync(Discovery)(
    NodeFS.readFileSync(NodePath.join(home, "outside-agents.json"), "utf8"),
  );
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw" } },
  });
  return new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: file.port,
        path: "/mcp/outside",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${file.token}`,
          ...headers,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
};

describe("outside agents", { tags: ["outside-agents"] }, () => {
  test(
    "a client drives prkit through its launcher, at the level the owner set, and never reaches GitHub",
    { timeout: 300_000 },
    async ({ app, screen, browser }) => {
      const name = "outside-agents";
      const log = transcript("outside-agents");
      const fake = await startFakeGitHub(name);
      const claude = setUpFakeClaude(name);
      let bridge: Bridge | null = null;
      try {
        let run = startFakeInstance(name, fake, ["--claude", claude.file]);
        const fixtures = { app, screen, browser };
        // The launcher is there from the first launch, and holds no secret.
        const launcher = NodeFS.readFileSync(NodePath.join(run.home, "bin", "prkit-mcp"), "utf8");
        expect(launcher).toContain("mcp-bridge");
        expect(launcher.toLowerCase()).not.toContain("token");
        const file = NodePath.join(run.home, "outside-agents.json");
        expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);

        // Off by default: the client connects and is told how to turn it on.
        bridge = startBridge(run.home, CLIENT);
        log.note("initialize while off", await bridge.initialize());
        expect(await bridge.tools()).toEqual(["prkit_status"]);
        const off = await bridge.call("prkit_status");
        log.note("prkit_status while off", off);
        expect(off).toMatchObject({ isError: true, text: OFF });

        // On, at Read only: reads only.
        await app.open(run.openUrl);
        await openOutsideSettings(fixtures);
        await app.screenshot("outside-agents-off");
        await switchOn(fixtures, true);
        await expect(screen.getByRole("radio", "Read only")).toBeChecked();
        await expect(
          screen.getByText("None yet. A client shows here after its first call."),
        ).toBeVisible();
        await expect
          .poll(() => bridge?.notifications.length ?? 0, { timeout: 20_000 })
          .toBeGreaterThan(0);
        expect(bridge.notifications).toContain("notifications/tools/list_changed");
        await toolsSettle(bridge, READS);
        log.note("tools at Read only", await bridge.tools());
        const inbox = await bridge.call("list_inbox");
        expect(inbox).toMatchObject({ isError: false });
        expect("text" in inbox ? inbox.text : "").toContain("github.com/budget/fixtures#3");
        const refused = await bridge.call("open_pull_request", { url: PR_9 });
        log.note("open_pull_request at Read only", refused);
        expect(refused).toEqual({ rpcError: expect.stringContaining("not found") });
        await expect(screen.getByRole("list", "Connected clients")).toContainText(CLIENT, {
          timeout: 30_000,
        });
        await app.screenshot("outside-agents-read-only");

        // Only the bridge gets in: no Origin, the loopback Host, the current token.
        expect(await raw(run.home, { origin: "http://localhost:5173" })).toBe(403);
        expect(await raw(run.home, { authorization: "Bearer wrong" })).toBe(401);
        expect(await raw(run.home, { host: "localhost" })).toBe(403);

        // Read and start work.
        await screen.getByRole("radio", "Read and start work").tap();
        await expect(screen.getByText("Outside agents can read and start work")).toBeVisible({
          timeout: 15_000,
        });
        await toolsSettle(bridge, ALL);

        // Opening a PR shows it in the app at once, from Settings to its tab.
        const opened = await bridge.call("open_pull_request", { url: PR_9 });
        log.note("open_pull_request", opened);
        expect(opened).toMatchObject({ isError: false });
        await expect(screen.getByRole("heading", "Keyboard fixture 9")).toBeVisible({
          timeout: 15_000,
        });
        await expect(browser.locator("[data-open-pr]")).toHaveCount(1);
        await app.screenshot("outside-agents-opened-pr");

        // A draft comment, once however often the client retries it.
        const comment = {
          url: PR_9,
          path: "src/limits.ts",
          line: 2,
          body: "Name the limit.",
          clientRequestId: "e2e-comment-1",
        };
        const added = await bridge.call("add_review_comment", comment);
        log.note("add_review_comment", added);
        expect(added).toMatchObject({ isError: false });
        expect(await bridge.call("add_review_comment", comment)).toEqual(added);
        const comments = await bridge.call("list_review_comments", { url: PR_9 });
        log.note("list_review_comments", comments);
        expect(
          "text" in comments ? (comments.text.match(/Name the limit\./g) ?? []).length : 0,
        ).toBe(1);

        // Sent to the fix agent: the Fixes tab names the client. The fake GitHub has no git, so
        // the turn ends at its checkout; its push would be the owner's click anyway.
        const sent = await bridge.call("send_to_fix_agent", {
          url: PR_9,
          clientRequestId: "e2e-send-1",
        });
        log.note("send_to_fix_agent", sent);
        expect(sent).toMatchObject({ isError: false });
        const waited = await bridge.call("wait_for", {
          url: PR_9,
          what: "fix",
          timeoutSeconds: 60,
        });
        log.note("wait_for fix", waited);
        expect(waited).toMatchObject({ isError: false });
        await app.open(
          `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=fixes`,
        );
        const turn = screen.getByRole("list", "Fixes").getByRole("article").first();
        await expect(turn).toContainText(`Started from ${CLIENT}`, { timeout: 30_000 });
        await app.screenshot("outside-agents-fix-started-from");
        expect(
          readRows(
            run.home,
            "SELECT started_by FROM fixer_turns WHERE fixer_id IN (SELECT id FROM fixers WHERE pr_key = 'github.com/budget/fixtures#9')",
          ),
        ).toEqual([{ started_by: CLIENT }]);
        // The owner's Retry runs the client's request again: it still waits for Push.
        await turn.getByRole("button", "Retry").tap();
        await expect
          .poll(
            () =>
              readRows(
                run.home,
                "SELECT trigger, started_by FROM fixer_turns WHERE fixer_id IN (SELECT id FROM fixers WHERE pr_key = 'github.com/budget/fixtures#9') ORDER BY created_at",
              ),
            { timeout: 30_000 },
          )
          .toEqual([
            { trigger: "user", started_by: CLIENT },
            { trigger: "retry", started_by: CLIENT },
          ]);

        // Reset access: a new token. The bridge reads the new file and carries on.
        await openOutsideSettings(fixtures);
        await screen.getByRole("button", "Reset access").tap();
        await expect(screen.getByText("Access reset")).toBeVisible({ timeout: 15_000 });
        await statusSettles(bridge, null);
        log.note("prkit_status after Reset access", await bridge.call("prkit_status"));

        // prkit quits: the client is told; prkit opens again: the next call works.
        stopFakeInstance(name, { keepHome: true });
        await statusSettles(bridge, NOT_OPEN);
        log.note("prkit_status while prkit is closed", await bridge.call("prkit_status"));
        run = startFakeInstance(name, fake, ["--claude", claude.file]);
        await statusSettles(bridge, null);
        await toolsSettle(bridge, ALL);
        log.note("prkit_status after a restart", await bridge.call("prkit_status"));

        // Off again: refused, with the way back on.
        await app.open(run.openUrl);
        await openOutsideSettings(fixtures);
        await switchOn(fixtures, false);
        await statusSettles(bridge, OFF);
        expect(await bridge.tools()).toEqual(["prkit_status"]);

        // Nothing reached GitHub.
        const writes = await fake.writes();
        log.note("fake GitHub writes", writes);
        expect(writes).toEqual([]);
        log.note("bridge stderr", bridge.stderr() || "(empty)");
      } finally {
        log.save();
        await bridge?.stop();
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "with two accounts on the host, a client names the account, and prkit names the options",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "outside-agents-accounts";
      const log = transcript("outside-agents-accounts");
      const fake = await startFakeGitHub(name, { secondAccount: true });
      let bridge: Bridge | null = null;
      try {
        const run = startFakeInstance(name, fake);
        await app.open(run.openUrl);
        await openOutsideSettings({ app, screen, browser });
        await switchOn({ app, screen, browser }, true);
        bridge = startBridge(run.home, CLIENT);
        await bridge.initialize();
        await toolsSettle(bridge, READS);
        const status = await bridge.call("prkit_status");
        expect("text" in status ? status.text : "").toContain("github.com/budget-second");

        // In no inbox, and two ready accounts on github.com: it asks, naming both.
        const unknown = await bridge.call("read_pull_request", { url: PR_9 });
        log.note("read_pull_request #9 without accountId", unknown);
        expect(unknown).toEqual({
          isError: true,
          text: "No account's inbox in prkit has github.com/budget/fixtures#9. Pass accountId, one of: github.com/budget-second, github.com/budget-test.",
        });
        // In both inboxes: it asks too, naming the two that reach it.
        await bridge.call("list_inbox", { refresh: true });
        const both = await bridge.call("read_pull_request", {
          url: "https://github.com/budget/fixtures/pull/3",
        });
        log.note("read_pull_request #3 without accountId", both);
        expect(both).toMatchObject({ isError: true });
        expect("text" in both ? both.text : "").toMatch(
          /^Several accounts reach github\.com\/budget\/fixtures#3: .*Pass accountId to say which\.$/,
        );
        expect("text" in both ? both.text : "").toContain("github.com/budget-second");
        expect("text" in both ? both.text : "").toContain("github.com/budget-test");

        // Named, it reads through that account; an account prkit doesn't have is refused.
        const named = await bridge.call("read_pull_request", {
          url: PR_9,
          accountId: "github.com/budget-second",
        });
        log.note("read_pull_request #9 through budget-second", named);
        expect("json" in named ? named.json : null).toMatchObject({
          accountId: "github.com/budget-second",
        });
        const stranger = await bridge.call("read_pull_request", {
          url: PR_9,
          accountId: "github.com/octocat",
        });
        expect(stranger).toMatchObject({ isError: true });
        expect("text" in stranger ? stranger.text : "").toContain(
          "prkit has no account github.com/octocat on github.com",
        );
      } finally {
        log.save();
        await bridge?.stop();
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "a guide and a fix started by a client are written, and the fix waits for Push",
    { timeout: 300_000, skip: NEEDS_FIXTURE },
    async ({ app, screen, browser }) => {
      const name = "outside-agents-fixture";
      const log = transcript("outside-agents-fixture");
      const claude = setUpFakeClaude(name);
      let bridge: Bridge | null = null;
      try {
        const run = startInstance(name, ["--claude", claude.file]);
        const fixtures = { app, screen, browser };
        await app.open(run.openUrl);
        await openOutsideSettings(fixtures);
        await switchOn(fixtures, true);
        await screen.getByRole("radio", "Read and start work").tap();
        await expect(screen.getByText("Outside agents can read and start work")).toBeVisible({
          timeout: 15_000,
        });
        bridge = startBridge(run.home, CLIENT);
        await bridge.initialize();
        await toolsSettle(bridge, ALL);
        const pr = {
          url: `https://github.com/${FIXTURE_REPO}/pull/1`,
          accountId: FIXTURE_ACCOUNT,
        };

        const started = await bridge.call("generate_guide", pr);
        log.note("generate_guide", started);
        expect(started).toMatchObject({ isError: false });
        expect("text" in started ? started.text : "").toContain(CLIENT);
        const guideDone = await bridge.call("wait_for", {
          ...pr,
          what: "guide",
          timeoutSeconds: 240,
        });
        log.note("wait_for guide", guideDone);
        const guide = await bridge.call("read_guide", pr);
        log.note("read_guide", guide);
        expect(guide).toMatchObject({ isError: false });
        expect("text" in guide ? guide.text : "").toContain("chapters");

        const detail = await bridge.call("read_pull_request", pr);
        log.note("read_pull_request", detail);
        const added = Schema.decodeUnknownSync(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.String })),
          }),
        )("json" in detail ? detail.json : {}).files.find((file) => file.status === "added");
        expect(added).toBeDefined();
        const comment = await bridge.call("add_review_comment", {
          ...pr,
          path: added?.path ?? "",
          line: 1,
          body: "Say what this file is for in one line at its top.",
          clientRequestId: "fixture-comment-1",
        });
        log.note("add_review_comment", comment);
        expect(comment).toMatchObject({ isError: false });
        const sent = await bridge.call("send_to_fix_agent", {
          ...pr,
          clientRequestId: "fixture-send-1",
        });
        log.note("send_to_fix_agent", sent);
        expect(sent).toMatchObject({ isError: false });
        const fixDone = await bridge.call("wait_for", { ...pr, what: "fix", timeoutSeconds: 240 });
        log.note("wait_for fix", fixDone);
        const fix = await bridge.call("read_fix", pr);
        log.note("read_fix", fix);
        expect("json" in fix ? fix.json : null).toMatchObject({ state: "waiting-for-push" });
        expect(
          readRows(
            run.home,
            `SELECT json_extract(status, '$._tag') AS status, started_by FROM fixer_turns`,
          ),
        ).toEqual([{ status: "ready", started_by: CLIENT }]);

        await app.open(
          `${run.url}/pr/github.com/${FIXTURE_REPO}/1?account=${encodeURIComponent(FIXTURE_ACCOUNT)}&tab=fixes`,
        );
        const turn = screen.getByRole("list", "Fixes").getByRole("article").first();
        await expect(turn).toContainText(`Started from ${CLIENT}`, { timeout: 30_000 });
        await expect(turn.getByRole("button", /^Push/).first()).toBeVisible();
        await app.screenshot("outside-agents-fix-waits-for-push");
        log.note("bridge stderr", bridge.stderr() || "(empty)");
      } finally {
        log.save();
        await bridge?.stop();
        stopFakeInstance(name, { keepHome: false });
      }
    },
  );
});
