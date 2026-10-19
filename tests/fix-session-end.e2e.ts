import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { isAlive } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, sendLineToAgent } from "./fixActions.ts";
import { processGroup, processStart, readRows, stopAgentGroup } from "./fixturePr.ts";
import { outsideGit } from "./outsideGit.ts";

const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const pull = (url: string, number: number, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=${tab}`;
const FILE = "src/change-0.ts";

/** Each fix of a pull request, oldest first: its state, whether it let go of the checkout, its notes and drafts. */
const fixesOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT json_extract(t.status, '$._tag') AS state, json_extract(t.status, '$.reason') AS reason,
       t.finished_at IS NOT NULL AS finished,
       (SELECT COUNT(*) FROM fixer_activity a WHERE a.turn_id = t.id AND a.text = 'Stopped the agent') AS notes,
       (SELECT group_concat(c.state) FROM pending_comments c WHERE c.fixer_turn_id = t.id) AS held
     FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(number)}'
     ORDER BY t.created_at, t.rowid`,
  );
const statesOf = (home: string, number: number) =>
  fixesOf(home, number).map((fix) => String(fix.state));
const idsOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT t.id FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
     WHERE f.pr_key = '${keyOf(number)}' ORDER BY t.created_at, t.rowid`,
  ).map((fix) => String(fix.id));
const draftsOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT state, fixer_turn_id AS turn FROM pending_comments WHERE pr_key = '${keyOf(number)}' ORDER BY rowid`,
  );
const sessionOf = (home: string, number: number) =>
  readRows(home, `SELECT id, ended FROM fixers WHERE pr_key = '${keyOf(number)}'`)[0];

/** The agent prkit started for the fix it is writing on pull request `number`, other than `before`'s. */
const agentOf = async (home: string, number: number, before = 0) => {
  const query = `SELECT t.agent_pid AS pid FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
    WHERE f.pr_key = '${keyOf(number)}' AND json_extract(t.status, '$._tag') = 'running'
      AND t.agent_pid IS NOT NULL AND t.agent_pid != ${before}`;
  await expect.poll(() => readRows(home, query).length, { timeout: 30_000 }).toBe(1);
  const pid = Number(readRows(home, query)[0]?.pid);
  return { pid, startedAt: processStart(pid) };
};

/** A fix Stop dropped, once, with its drafts back. */
const DROPPED = { state: "discarded", reason: "ended", notes: 1, held: null };

/** The commits prkit keeps reachable for ready fixes, in the pull requests' repository cache. */
const heldCommits = (home: string) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      `--git-dir=${NodePath.join(home, "repos", "github.com", "budget", "fixtures.git")}`,
      "for-each-ref",
      "--format=%(refname)",
      "refs/prkit/fixes",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line !== "");

/** While it stands, prkit's server waits right after it stores a fix session's end (`e2eHold.ts`). */
const holdEnds = (home: string, on: boolean) => {
  const file = NodePath.join(home, "e2e-holds", "fix-session-end");
  if (on) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "");
  } else NodeFS.rmSync(file, { force: true });
};

/** While it stands, giving drafts back fails the way a full disk or a busy database would. */
const failDraftReturns = (home: string, on: boolean) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.exec(
      on
        ? `CREATE TRIGGER e2e_fail_draft_returns BEFORE UPDATE OF state ON pending_comments
           WHEN new.state = 'draft' BEGIN SELECT RAISE(ABORT, 'e2e: no drafts back'); END`
        : "DROP TRIGGER e2e_fail_draft_returns",
    );
  } finally {
    db.close();
  }
};

test(
  "a fix session's end cut off by a crash finishes on the next start, once: agent stopped, fixes discarded, drafts back, checkout and held commit gone",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-session-end";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let agent: { pid: number; startedAt: string } | null = null;
    let home = "";
    try {
      for (const number of [4, 6]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);

      // #4: a fix ready to push, and one queued behind it. #6: a fix the agent is still
      // writing, and one queued behind it.
      claude.edits({ [FILE]: 'export const change0 = "Fixed by the agent";\n' });
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 4), { timeout: 60_000 }).toEqual(["ready"]);
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Say why it starts here.");
      await expect
        .poll(() => statesOf(run.home, 4), { timeout: 30_000 })
        .toEqual(["ready", "queued"]);
      claude.hold();
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["running"]);
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Say why it starts here.");
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 30_000 })
        .toEqual(["running", "queued"]);
      agent = await agentOf(run.home, 6);
      const sessions = [4, 6].map((number) => String(sessionOf(run.home, number)?.id));
      const checkouts = sessions.map((id) => NodePath.join(run.home, "fixes", id));
      for (const checkout of checkouts) expect(NodeFS.existsSync(checkout)).toBe(true);
      const [readyFix] = idsOf(run.home, 4);
      expect(heldCommits(run.home)).toEqual([`refs/prkit/fixes/${String(readyFix)}`]);
      for (const number of [4, 6])
        expect(draftsOf(run.home, number).map((draft) => draft.state)).toEqual([
          "sent-to-agent",
          "sent-to-agent",
        ]);

      // A save that fails while Stop ends the session leaves it as it was, so Stop works again.
      failDraftReturns(run.home, true);
      await app.open(pull(run.url, 6, "fixes"));
      await screen.getByRole("button", "Stop agent").tap();
      await expect(screen.getByRole("alert")).toContainText(
        "prkit couldn't read or save the fix. Try again.",
        { timeout: 30_000 },
      );
      await app.screenshot("stop-failed");
      expect(sessionOf(run.home, 6)?.ended).toBeNull();
      expect(statesOf(run.home, 6)).toEqual(["running", "queued"]);
      expect(processGroup(agent.pid).length).toBeGreaterThan(0);
      await expect(screen.getByRole("button", "Stop agent")).toBeVisible();
      failDraftReturns(run.home, false);

      // Stop on both. Each end is stored, with its fixes dropped and the drafts back, and
      // prkit is killed before it stops the agent, lets go of the ready commit or removes a
      // checkout.
      holdEnds(run.home, true);
      for (const number of [4, 6]) {
        await app.open(pull(run.url, number, "fixes"));
        await screen.getByRole("button", "Stop agent").tap();
        await expect
          .poll(() => sessionOf(run.home, number)?.ended, { timeout: 30_000 })
          .toBe("stopped");
      }
      for (const number of [4, 6])
        expect(fixesOf(run.home, number)).toEqual([
          { ...DROPPED, finished: 0 },
          { ...DROPPED, finished: 0 },
        ]);
      for (const checkout of checkouts) expect(NodeFS.existsSync(checkout)).toBe(true);
      expect(heldCommits(run.home)).toEqual([`refs/prkit/fixes/${String(readyFix)}`]);
      process.kill(run.serverPid, "SIGKILL");
      await expect.poll(() => isAlive(run.pid), { timeout: 15_000 }).toBe(false);
      const agentOutlivedServer = processGroup(agent.pid).length > 0;
      holdEnds(run.home, false);
      claude.release();

      // The next start finishes both ends the way Stop would have, each step once.
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      const finished = () => {
        for (const number of [4, 6]) {
          expect(fixesOf(run.home, number)).toEqual([
            { ...DROPPED, finished: 1 },
            { ...DROPPED, finished: 1 },
          ]);
          expect(draftsOf(run.home, number)).toEqual([
            { state: "draft", turn: null },
            { state: "draft", turn: null },
          ]);
          expect(sessionOf(run.home, number)?.ended).toBe("stopped");
        }
        for (const checkout of checkouts) expect(NodeFS.existsSync(checkout)).toBe(false);
        expect(heldCommits(run.home)).toEqual([]);
      };
      finished();
      expect(agentOutlivedServer).toBe(true);
      expect(processGroup(agent.pid)).toEqual([]);
      await app.open(pull(run.url, 6, "fixes"));
      await expect(screen.getByRole("article", "Fix 1 comment: Discarded")).toHaveCount(2, {
        timeout: 30_000,
      });
      await expect(screen.getByRole("button", "Stop agent")).toHaveCount(0);
      await app.screenshot("ended-after-restart");

      // Running it all again changes nothing.
      stopFakeInstance(name, { keepHome: true });
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      finished();
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      if (agent !== null) stopAgentGroup(agent.pid, agent.startedAt);
      fake.stop();
    }
  },
);

test(
  "a discarded fix lets the next one start, and Stop finishes its work when the window closes while it runs",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-session-end-closed";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const agents: Array<{ pid: number; startedAt: string }> = [];
    let home = "";
    try {
      await fake.gitHead(6, git.head(6));
      const run = git.start(() =>
        startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]),
      );
      home = run.home;
      await app.open(run.openUrl);
      claude.hold();
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["running"]);
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Say why it starts here.");
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 30_000 })
        .toEqual(["running", "queued"]);
      const first = await agentOf(run.home, 6);
      agents.push(first);
      const checkout = NodePath.join(run.home, "fixes", String(sessionOf(run.home, 6)?.id));

      // Discarding the fix the agent is writing stops it, gives its draft back, and the next starts.
      await app.open(pull(run.url, 6, "fixes"));
      await screen.getByRole("button", "Stop and discard").tap();
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 30_000 })
        .toEqual(["discarded", "running"]);
      expect(processGroup(first.pid)).toEqual([]);
      const second = await agentOf(run.home, 6, first.pid);
      agents.push(second);
      expect(fixesOf(run.home, 6)[0]).toEqual({
        state: "discarded",
        reason: "user",
        finished: 1,
        notes: 0,
        held: null,
      });
      expect(draftsOf(run.home, 6).map((draft) => draft.state)).toEqual(["draft", "sent-to-agent"]);

      // The window closes while Stop holds right after storing the end.
      holdEnds(run.home, true);
      await screen.getByRole("button", "Stop agent").tap();
      await expect.poll(() => sessionOf(run.home, 6)?.ended, { timeout: 30_000 }).toBe("stopped");
      await app.open("about:blank");
      holdEnds(run.home, false);

      await expect
        .poll(() => fixesOf(run.home, 6)[1], { timeout: 30_000 })
        .toEqual({ ...DROPPED, finished: 1 });
      expect(processGroup(second.pid)).toEqual([]);
      expect(NodeFS.existsSync(checkout)).toBe(false);
      expect(draftsOf(run.home, 6)).toEqual([
        { state: "draft", turn: null },
        { state: "draft", turn: null },
      ]);
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      for (const agent of agents) stopAgentGroup(agent.pid, agent.startedAt);
      fake.stop();
    }
  },
);
