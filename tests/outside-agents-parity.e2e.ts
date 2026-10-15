import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import * as Results from "../apps/server/src/outside/paritySchemas.ts";
import {
  AddedComment,
  InboxListResult,
  OpenPullRequestsResult,
  WaitResult,
} from "../apps/server/src/outside/schemas.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { outsideGit } from "./outsideGit.ts";
import { startBridge, type Bridge } from "./outsideBridge.ts";

test(
  "outside tools cover app reads and local work with paging, selections and no GitHub writes",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "outside-parity";
    const fake = await startFakeGitHub(name, { secondAccount: true });
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    let bridge: Bridge | null = null;
    const lines: string[] = [];
    try {
      const run = git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      const modifier = await browser.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
      );
      await browser.keyboard.press(`${modifier}+Comma`);
      await screen.getByRole("link", "Outside agents").tap();
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read")).toBeVisible();
      bridge = startBridge(run.home, "parity client");
      await bridge.initialize();
      const client = bridge;
      const ok = async (tool: string, input: object = {}) => {
        const answer = await client.call(tool, input);
        lines.push(`## ${tool}\n${JSON.stringify({ input, answer }, null, 2)}`);
        expect(answer).toMatchObject({ isError: false });
        if (!("json" in answer)) throw new Error(`${tool} returned no structured result`);
        return answer.json;
      };
      const refusal = async (tool: string, input: object, text: string) => {
        const answer = await client.call(tool, input);
        lines.push(`## refused ${tool}\n${JSON.stringify(answer, null, 2)}`);
        expect(answer).toMatchObject({ isError: true });
        expect("text" in answer ? answer.text : "").toContain(text);
      };
      const listed = Schema.decodeUnknownSync(Results.AccountsResult)(
        await ok("list_accounts", { limit: 1 }),
      );
      expect(listed.items.length).toBe(1);
      expect(listed.nextCursor).toBeTruthy();
      const moreAccounts = Schema.decodeUnknownSync(Results.AccountsResult)(
        await ok("list_accounts", { cursor: listed.nextCursor, limit: 1 }),
      );
      const first = listed.items[0];
      const second = moreAccounts.items[0];
      if (first === undefined || second === undefined)
        throw new Error("Two fake accounts are required");
      const accountId = first.accountId;
      const pr = { owner: "budget", repo: "fixtures", number: 1, accountId };
      const ninth = { ...pr, number: 9 };
      const repo = { owner: "budget", repo: "fixtures", accountId };
      const repositories = Schema.decodeUnknownSync(Results.RepositoriesResult)(
        await ok("list_repositories", { accountId, refresh: true, limit: 1 }),
      );
      expect(repositories.items.length).toBe(1);
      expect(repositories.accounts.every((entry) => entry.accountId === accountId)).toBe(true);
      await ok("list_repository_pull_requests", repo);
      const inbox = Schema.decodeUnknownSync(InboxListResult)(
        await ok("list_inbox", {
          accountId,
          reason: "authored",
          repository: { host: "github.com", owner: "budget", name: "fixtures" },
          limit: 1,
        }),
      );
      expect(inbox.total).toBeGreaterThan(1);
      expect(inbox.nextCursor).toBeTruthy();
      const nextInbox = Schema.decodeUnknownSync(InboxListResult)(
        await ok("list_inbox", {
          accountId,
          reason: "authored",
          repository: { host: "github.com", owner: "budget", name: "fixtures" },
          limit: 1,
          cursor: inbox.nextCursor,
        }),
      );
      expect(
        nextInbox.accounts.flatMap((entry) =>
          entry.sections.flatMap((section) => section.pullRequests.map((pr) => pr.key)),
        ),
      ).not.toEqual(
        inbox.accounts.flatMap((entry) =>
          entry.sections.flatMap((section) => section.pullRequests.map((pr) => pr.key)),
        ),
      );
      const otherInbox = Schema.decodeUnknownSync(InboxListResult)(
        await ok("list_inbox", { accountId: second.accountId, reason: "review-requested" }),
      );
      expect(otherInbox.accounts.every((entry) => entry.accountId === second.accountId)).toBe(true);
      const empty = Schema.decodeUnknownSync(InboxListResult)(
        await ok("list_inbox", {
          accountId,
          search: "no matching title",
          state: "closed",
          draft: true,
          checks: "failing",
          stacks: "unstacked",
        }),
      );
      expect(empty.total).toBe(0);
      const agents = Schema.decodeUnknownSync(Results.AgentsResult)(await ok("list_agents"));
      expect(JSON.stringify(agents)).not.toContain("environment");
      const agent = agents.items.find((entry) => entry.kind === "claude" && entry.ready);
      const model = agent?.models.find((entry) =>
        entry.options.some((option) => option.id === "effort"),
      );
      if (agent === undefined || model === undefined)
        throw new Error("The stand-in agent should offer effort");
      const selection = {
        instance: agent.instance,
        model: model.slug,
        options: [{ id: "effort", value: "high" }],
      };
      for (const [tool, input] of [
        ["read_pull_request_files", ninth],
        ["read_file_contents", { ...ninth, path: "src/limits.ts", side: "new" }],
        ["read_timeline", { ...pr, number: 8 }],
        ["read_threads", ninth],
        ["read_checks", ninth],
        ["read_conversation", ninth],
        ["read_stack", pr],
        ["read_pull_request_candidates", ninth],
        ["list_reviews", {}],
        ["list_guide_revisions", pr],
        ["read_guide_progress", pr],
        ["read_guide_duration", { instance: agent.instance, lines: 10 }],
        ["read_guide_scope", { scope: { _tag: "global" } }],
        ["list_guide_repositories", {}],
        ["find_guide_repository", repo],
        ["list_fixes", {}],
        ["read_fix_access", ninth],
        ["read_settings", {}],
      ] satisfies ReadonlyArray<readonly [string, object]>)
        await ok(tool, input);
      const files = Schema.decodeUnknownSync(Results.FilesResult)(
        await ok("read_pull_request_files", ninth),
      );
      await refusal(
        "read_pull_request_files",
        { ...pr, cursor: files.nextCursor ?? "wrong" },
        "cursor",
      );
      expect(
        await client.call("save_pull_request_guide_settings", {
          ...pr,
          expectedVersion: 0,
          edit: { _tag: "guidance", text: "Hidden", mode: "append" },
        }),
      ).toMatchObject({ rpcError: expect.stringContaining("not found") });
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(screen.getByText("Outside agents can read and start work")).toBeVisible();
      await expect
        .poll(async () => (await client.tools()).includes("edit_review_comment"), {
          timeout: 20_000,
        })
        .toBe(true);
      await ok("save_inbox_filters", { search: "fixture", account: accountId, repository: null });
      await ok("open_pull_request", { ...pr, focus: false });
      await ok("open_pull_request", { ...ninth, focus: false });
      const tabs = Schema.decodeUnknownSync(OpenPullRequestsResult)(
        await ok("list_open_pull_requests"),
      );
      await ok("reorder_pull_requests", { keys: tabs.open.map((entry) => entry.key).toReversed() });
      await ok("focus_pull_request", pr);
      await expect(screen.getByRole("heading", "Budget fixture 1")).toBeVisible();
      await app.screenshot("outside-parity-focused-tab");
      await ok("close_pull_request", ninth);

      const settings = Schema.decodeUnknownSync(Results.GuideSettingsResult)(
        await ok("read_guide_settings", pr),
      );
      await refusal(
        "generate_guide",
        {
          ...pr,
          ...selection,
          options: [{ id: "effort", value: "invalid" }],
          guidance: { expectedVersion: 0, text: "Must not save", mode: "append" },
        },
        "can't use",
      );
      await refusal("generate_guide", { ...pr, model: model.slug }, "instance and model");
      claude.hold();
      await ok("generate_guide", {
        ...pr,
        ...selection,
        guidance: {
          expectedVersion: settings.scopes.pullRequest.guidance.version,
          text: "Explain the local fixture",
          mode: "append",
        },
        focus: {
          expectedVersion: 0,
          areas: [{ id: null, label: "Safety", question: "Are the changes safe?" }],
          overrides: [],
        },
      });
      await refusal(
        "save_pull_request_guide_settings",
        { ...pr, expectedVersion: 0, edit: { _tag: "guidance", text: "Stale", mode: "append" } },
        "changed since",
      );
      await expect
        .poll(
          async () =>
            Schema.decodeUnknownSync(Results.ProgressResult)(await ok("read_guide_progress", pr))
              .status.state,
          { timeout: 30_000 },
        )
        .toBe("writing");
      const progress = Schema.decodeUnknownSync(Results.ProgressResult)(
        await ok("read_guide_progress", pr),
      );
      expect(progress.attempt?.startedBy).toBe("parity client");
      expect(progress.attempt?.files.length).toBeGreaterThan(0);
      claude.release();
      await ok("wait_for", { ...pr, what: "guide", timeoutSeconds: 50 });
      const revisions = Schema.decodeUnknownSync(Results.RevisionsResult)(
        await ok("list_guide_revisions", pr),
      );
      const revision = revisions.items[0];
      if (revision === undefined) throw new Error("No accepted stand-in guide");
      const written = Schema.decodeUnknownSync(Results.RevisionResult)(
        await ok("read_guide_revision", { ...pr, revision: revision.revision }),
      );
      expect(written.config.focusAreas.some((area) => area.active)).toBe(true);
      let diff = Schema.decodeUnknownSync(Results.FilesResult)(
        await ok("read_review_diff", { ...pr, attemptId: revision.attemptId, limit: 1 }),
      );
      expect(diff.truncated).toBe(true);
      let fragments = diff.items.length;
      while (diff.nextCursor !== null) {
        diff = Schema.decodeUnknownSync(Results.FilesResult)(
          await ok("read_review_diff", {
            ...pr,
            attemptId: revision.attemptId,
            limit: 1,
            cursor: diff.nextCursor,
          }),
        );
        fragments += diff.items.length;
        if (fragments > 100) throw new Error("Diff paging did not finish");
      }
      expect(fragments).toBeGreaterThan(1);
      await ok("stop_guide", pr);
      await ok("generate_guide", {
        ...pr,
        ...selection,
        stack: "chosen-layers",
        layers: [2],
        regenerate: true,
      });
      expect(
        Schema.decodeUnknownSync(WaitResult)(
          await ok("wait_for", { ...pr, number: 2, what: "guide", timeoutSeconds: 50 }),
        ).guide?.state,
      ).toBe("watching");
      await ok("stop_guide", { ...pr, number: 2 });
      await ok("generate_guide", { ...pr, ...selection, stack: "whole-stack", regenerate: false });
      await ok("generate_guide", { ...pr, ...selection, stack: "whole-stack", regenerate: true });
      await ok("wait_for", { ...pr, what: "guide", timeoutSeconds: 50 });
      expect(
        Schema.decodeUnknownSync(WaitResult)(
          await ok("wait_for", { ...pr, number: 2, what: "guide", timeoutSeconds: 50 }),
        ).guide?.state,
      ).toBe("watching");
      await ok("stop_guide", pr);
      await ok("stop_guide", { ...pr, number: 2 });

      const draft = Schema.decodeUnknownSync(AddedComment)(
        await ok("add_review_comment", {
          ...ninth,
          path: "src/limits.ts",
          line: 2,
          body: "Explain these limits",
        }),
      );
      await ok("edit_review_comment", { ...ninth, id: draft.id, body: "Explain the larger limit" });
      await refusal(
        "edit_review_comment",
        { ...pr, id: draft.id, body: "Wrong PR" },
        "isn't on this pull request",
      );
      const placement = {
        anchor: {
          path: "src/limits.ts",
          start: { side: "new", line: 3 },
          end: { side: "new", line: 3 },
        },
        snippet: "+  slug: 64,",
        commitSha: files.headSha,
      };
      await ok("move_review_comment", { ...ninth, id: draft.id, placement });
      const sent = await ok("send_to_fix_agent", {
        ...ninth,
        ...selection,
        draftIds: [draft.id],
        clientRequestId: "parity-fix",
      });
      const turn = Schema.decodeUnknownSync(
        Schema.Struct({ turnId: Results.FixTurnInput.fields.turnId }),
      )(sent);
      await ok("wait_for", { ...ninth, what: "fix", timeoutSeconds: 50 });
      const fix = Schema.decodeUnknownSync(Results.FixTurnResult)(
        await ok("read_fix_turn", { ...ninth, turnId: turn.turnId }),
      );
      expect(fix.turn.status._tag).toBe("ready");
      expect(fix.turn.startedBy).toBe("parity client");
      await ok("read_fix_diff", { ...ninth, turnId: turn.turnId });
      const patch = Schema.decodeUnknownSync(Results.TextResult)(
        await ok("read_fix_patch", { ...ninth, turnId: turn.turnId }),
      );
      expect(patch.items.map((part) => part.text).join("")).toContain("stand-in.md");
      await ok("list_fixes");
      expect(await fake.writes()).toEqual([]);
      lines.push(`## Fake GitHub budget\n${JSON.stringify(await fake.stats(), null, 2)}`);
      await ok("list_accounts");
      await ok("close_pull_request", pr);
      await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
      await app.screenshot("outside-parity-closed-last-tab");
      lines.push(`## Fake GitHub writes\n${JSON.stringify(await fake.writes())}`);
      await app.open(`${run.url}/settings/outside-agents`);
      await app.screenshot("outside-parity-complete");
    } finally {
      const dir = NodePath.join(repoRoot, ".e2e", "evidence", "u70");
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "parity.md"), `${lines.join("\n\n")}\n`);
      await bridge?.stop();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
