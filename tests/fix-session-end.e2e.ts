import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { isAlive } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, openSendToAgent, sendLineToAgent } from "./fixActions.ts";
import { processGroup, processStart, readRows, stopAgentGroup } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const pull = (url: string, number: number, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=${tab}`;
const FILE = "src/change-0.ts";
/** The file a journey comments on: #9's diff on the fake GitHub has only `src/limits.ts`. */
const commentedIn = (number: number) => (number === 9 ? "src/limits.ts" : FILE);

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

/** Each fix of a pull request, oldest first: its state and why, what started it, and the head it built on. */
const turnsOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT json_extract(t.status, '$._tag') AS state, json_extract(t.status, '$.reason') AS reason,
       json_extract(t.status, '$.message') AS message, t.trigger, t.head_sha AS head,
       t.finished_at IS NOT NULL AS finished
     FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(number)}'
     ORDER BY t.created_at, t.rowid`,
  );
/** The latest fix of a pull request: its state and how many changes were asked of it. */
const roundsOf = (number: number) =>
  `SELECT json_extract(t.status, '$._tag') AS state, t.rounds FROM fixer_turns t
   JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(number)}'
   ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`;
const checkoutOf = (home: string, number: number) =>
  NodePath.join(home, "fixes", String(sessionOf(home, number)?.id));

/** The files the latest fix of a pull request changed, from its checkout. */
const fixedFiles = (home: string, number: number) => {
  const [turn] = readRows(
    home,
    `SELECT t.head_sha AS head, t.commit_sha AS sha FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
     WHERE f.pr_key = '${keyOf(number)}' ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
  );
  return NodeChildProcess.execFileSync(
    "git",
    ["-C", checkoutOf(home, number), "diff", "--name-only", String(turn?.head), String(turn?.sha)],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line !== "");
};

/** Sends the pull request's one returned draft to the agent again, from its Files tab. */
const resend = async (page: Fixtures, filesUrl: string) => {
  await page.app.open(filesUrl);
  const send = await openSendToAgent(page, 1);
  await send.getByRole("button", "Send 1 comment to agent").tap();
  await expect(send).toHaveCount(0, { timeout: 30_000 });
};

/** What a push its session's end let finish says when it finds the branch moved to `sha`. */
const notRedone = (sha: string) =>
  `The branch moved to ${sha.slice(0, 7)} before the push, so prkit pushed nothing. The agent is stopped, so prkit isn't redoing it`;

/** The fix watcher's own reads would start a waiting fix too; at this interval none comes during a journey. */
const WATCHER_STAYS_OUT = "600000";

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

/**
 * While it stands, prkit's server waits at `point` (`e2eHold.ts`): right after it stores a fix
 * session's end, between starting a queued fix and running it, or before a push leaves.
 */
const holdAt = (
  home: string,
  point: "fix-session-end" | "fix-turn-start" | "fix-push",
  on: boolean,
) => {
  const file = NodePath.join(home, "e2e-holds", point);
  if (on) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "");
  } else NodeFS.rmSync(file, { force: true });
};
const holdEnds = (home: string, on: boolean) => holdAt(home, "fix-session-end", on);

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
        "prkit couldn't read or save the fix.",
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
      expect(processGroup(agent.pid).length).toBeGreaterThan(0);
      holdEnds(run.home, false);

      // The next start finishes both ends the way Stop would have, each step once. The agent is
      // still held, so only prkit can have stopped it.
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

test(
  "a fix sent again while Stop still ends the session waits for the end, then runs on a whole checkout, a crash included",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-session-reopen";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() =>
        startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          WATCHER_STAYS_OUT,
        ]),
      );
    let home = "";
    try {
      for (const number of [4, 6, 9]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);

      // #4 ends with nothing left to drop, #6 and #9 with a fix ready to push.
      claude.edits({ [FILE]: 'export const change0 = "Fixed by the agent";\n' });
      for (const number of [4, 6, 9]) {
        await sendLineToAgent(
          page,
          pull(run.url, number, "files"),
          commentedIn(number),
          "Name the change.",
        );
        await expect.poll(() => statesOf(run.home, number), { timeout: 60_000 }).toEqual(["ready"]);
      }
      await app.open(pull(run.url, 4, "fixes"));
      await screen
        .getByRole("article", "Fix 1 comment: Ready to review")
        .getByRole("button", "Discard")
        .tap();
      await expect.poll(() => statesOf(run.home, 4), { timeout: 30_000 }).toEqual(["discarded"]);

      // Stop holds right after it stores each end, and the owner sends the comment again meanwhile:
      // the fix waits, and the old checkout is still there.
      holdEnds(run.home, true);
      for (const number of [4, 6]) {
        await app.open(pull(run.url, number, "fixes"));
        await screen.getByRole("button", "Stop agent").tap();
        await expect
          .poll(() => sessionOf(run.home, number)?.ended, { timeout: 30_000 })
          .toBe("stopped");
      }
      claude.hold();
      for (const number of [4, 6]) {
        await resend(page, pull(run.url, number, "files"));
        expect(sessionOf(run.home, number)?.ended).toBeNull();
        expect(statesOf(run.home, number)).toEqual(["discarded", "queued"]);
        expect(NodeFS.existsSync(checkoutOf(run.home, number))).toBe(true);
      }

      // Once the end is done, each fix runs, and its commit holds the agent's change and nothing else.
      holdEnds(run.home, false);
      for (const number of [4, 6])
        await expect
          .poll(() => statesOf(run.home, number), { timeout: 60_000 })
          .toEqual(["discarded", "running"]);
      claude.release();
      for (const number of [4, 6]) {
        await expect
          .poll(() => statesOf(run.home, number), { timeout: 60_000 })
          .toEqual(["discarded", "ready"]);
        expect(fixedFiles(run.home, number)).toEqual([FILE, "stand-in.md"]);
      }

      // In the session that came back, asking the agent for a change runs it again on the result.
      await app.open(pull(run.url, 4, "fixes"));
      const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
      await ready.getByRole("button", "Ask the agent to change").tap();
      await screen
        .getByRole("textbox", "What should the agent change?")
        .fill("Say why it starts here.");
      await screen
        .getByRole("form", "Ask the agent to change")
        .getByRole("button", "Send to the agent")
        .tap();
      await expect
        .poll(() => readRows(run.home, roundsOf(4)), { timeout: 60_000 })
        .toEqual([{ state: "ready", rounds: 1 }]);
      expect(
        NodeChildProcess.execFileSync(
          "git",
          ["-C", checkoutOf(run.home, 4), "show", "HEAD:stand-in.md"],
          { encoding: "utf8" },
        ),
      ).toContain("Revised by the stand-in agent.");

      // #9: prkit dies while its end holds and the comment waits, with the end's removal of the
      // checkout left half done. The next start finishes the end and runs the fix on a whole checkout.
      holdEnds(run.home, true);
      await app.open(pull(run.url, 9, "fixes"));
      await screen.getByRole("button", "Stop agent").tap();
      await expect.poll(() => sessionOf(run.home, 9)?.ended, { timeout: 30_000 }).toBe("stopped");
      await resend(page, pull(run.url, 9, "files"));
      expect(statesOf(run.home, 9)).toEqual(["discarded", "queued"]);
      const checkout = checkoutOf(run.home, 9);
      process.kill(run.serverPid, "SIGKILL");
      await expect.poll(() => isAlive(run.pid), { timeout: 15_000 }).toBe(false);
      holdEnds(run.home, false);
      NodeFS.rmSync(NodePath.join(checkout, ".git"));
      NodeFS.rmSync(NodePath.join(checkout, "src"), { recursive: true });
      run = launch();
      await app.open(run.openUrl);
      await expect
        .poll(() => statesOf(run.home, 9), { timeout: 60_000 })
        .toEqual(["discarded", "ready"]);
      expect(fixedFiles(run.home, 9)).toEqual([FILE, "stand-in.md"]);
      expect(fixesOf(run.home, 9)[0]).toEqual({ ...DROPPED, finished: 1 });
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      fake.stop();
    }
  },
);

test(
  "a fix the queue starts just as Stop ends the session never runs: no checkout, no head, the session stays ended",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-session-start";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    let home = "";
    try {
      await fake.gitHead(6, git.head(6));
      const run = git.start(() =>
        startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]),
      );
      home = run.home;
      await app.open(run.openUrl);

      // On #6 the first fix fails once the agent lets go of it, and the second waits behind it.
      claude.hold();
      claude.failing(true);
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["running"]);
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Say why it starts here.");
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 30_000 })
        .toEqual(["running", "queued"]);
      const checkout = checkoutOf(run.home, 6);
      const [, second] = idsOf(run.home, 6);

      // The queue starts the second fix and holds before running it, and Stop ends the session there.
      holdAt(run.home, "fix-turn-start", true);
      claude.release();
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 30_000 })
        .toEqual(["failed", "preparing"]);
      await app.open(pull(run.url, 6, "fixes"));
      await screen.getByRole("button", "Stop agent").tap();
      await expect
        .poll(() => turnsOf(run.home, 6)[1], { timeout: 30_000 })
        .toMatchObject({ state: "discarded", reason: "ended", head: null, finished: 1 });
      await expect.poll(() => NodeFS.existsSync(checkout), { timeout: 30_000 }).toBe(false);
      claude.failing(false);

      // The held start goes on, finds its fix dropped and does nothing: no checkout, no head, no
      // activity past the stop, and the session stays ended.
      // The instance's log is kept across runs, so only what this run writes from here counts.
      const logFrom = NodeFS.statSync(run.log).size;
      holdAt(run.home, "fix-turn-start", false);
      await expect
        .poll(
          () =>
            NodeFS.readFileSync(run.log)
              .subarray(logFrom)
              .toString("utf8")
              .includes("A fix was dropped before it started") || NodeFS.existsSync(checkout),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(NodeFS.existsSync(checkout)).toBe(false);
      expect(turnsOf(run.home, 6)[1]).toMatchObject({
        state: "discarded",
        reason: "ended",
        head: null,
        finished: 1,
      });
      expect(
        readRows(
          run.home,
          `SELECT text FROM fixer_activity WHERE turn_id = '${String(second)}' ORDER BY id`,
        ).map((row) => String(row.text)),
      ).toEqual(["Stopped the agent"]);
      expect(sessionOf(run.home, 6)?.ended).toBe("stopped");
    } finally {
      if (home !== "") holdAt(home, "fix-turn-start", false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      fake.stop();
    }
  },
);

test(
  "a push Stop lets finish that finds the branch moved redoes nothing: the draft is back and nothing waits, after a restart too",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-session-spared-push";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    try {
      for (const number of [4, 6, 9]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      claude.edits({ [FILE]: 'export const change0 = "Fixed by the agent";\n' });
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 4), { timeout: 60_000 }).toEqual(["ready"]);
      const head = git.head(4);

      // Push holds before it reads the branch. Meanwhile someone pushes, and Stop ends the session,
      // which lets the push finish.
      holdAt(run.home, "fix-push", true);
      await app.open(pull(run.url, 4, "fixes"));
      const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
      await expect(ready.getByRole("button", "Push")).toBeEnabled({ timeout: 30_000 });
      await ready.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 4), { timeout: 30_000 }).toEqual(["pushing"]);
      const moved = git.commit(4, { "src/limits.ts": "export const limits = {};\n" });
      await screen.getByRole("button", "Stop agent").tap();
      await expect.poll(() => sessionOf(run.home, 4)?.ended, { timeout: 30_000 }).toBe("stopped");
      expect(statesOf(run.home, 4)).toEqual(["pushing"]);

      // The push finds the branch moved and pushes nothing. The session has ended, so nothing is
      // redone: no fix waits in it, and the comment is the owner's draft again.
      holdAt(run.home, "fix-push", false);
      const message = notRedone(moved);
      const settled = () => {
        expect(turnsOf(run.home, 4)).toEqual([
          { state: "discarded", reason: "moved", message, trigger: "user", head, finished: 1 },
        ]);
        expect(draftsOf(run.home, 4)).toEqual([{ state: "draft", turn: null }]);
        expect(sessionOf(run.home, 4)?.ended).toBe("stopped");
        expect(git.pushes()).toEqual([]);
      };
      // The toast comes once Push has its answer, so everything the push does is stored by then.
      await expect(screen.getByText("The branch moved")).toBeVisible({ timeout: 30_000 });
      settled();
      await expect(screen.getByText(message)).toBeVisible();
      await screenshotLightAndDark(app, browser, "spared-push-moved");
      await browser.setViewport({ width: 600, height: 720 });
      await expect(screen.getByRole("article", "Fix 1 comment: Discarded")).toContainText(message);
      await app.screenshot("spared-push-moved-narrow");
      await browser.setViewport({ width: 1280, height: 720 });
      await expect(screen.getByRole("button", "Review, 1 pending").first()).toBeVisible();

      // A restart changes nothing.
      stopFakeInstance(name, { keepHome: true });
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      settled();

      // #6: the owner sends a new comment after Stop, so the session is open again by the time the
      // spared push finds the branch moved. Only the new comment runs; the stopped one is theirs.
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["ready"]);
      holdAt(run.home, "fix-push", true);
      await app.open(pull(run.url, 6, "fixes"));
      const ready6 = screen.getByRole("article", "Fix 1 comment: Ready to review");
      await expect(ready6.getByRole("button", "Push")).toBeEnabled({ timeout: 30_000 });
      await ready6.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 6), { timeout: 30_000 }).toEqual(["pushing"]);
      const moved6 = git.commit(6, { "src/limits.ts": "export const limits = {};\n" });
      await screen.getByRole("button", "Stop agent").tap();
      await expect.poll(() => sessionOf(run.home, 6)?.ended, { timeout: 30_000 }).toBe("stopped");
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Say why it starts here.");
      expect(sessionOf(run.home, 6)?.ended).toBeNull();
      expect(statesOf(run.home, 6)).toEqual(["pushing", "queued"]);
      holdAt(run.home, "fix-push", false);
      await expect
        .poll(() => turnsOf(run.home, 6).map((turn) => [turn.state, turn.trigger]), {
          timeout: 60_000,
        })
        .toEqual([
          ["discarded", "user"],
          ["ready", "user"],
        ]);
      expect(turnsOf(run.home, 6)[0]?.message).toBe(notRedone(moved6));
      expect(draftsOf(run.home, 6).map((draft) => draft.state)).toEqual(["draft", "sent-to-agent"]);

      // #9: the push Stop lets finish fails (the fixture refuses pushes), so the fix is ready again
      // in the ended session. Asking the agent for a change there starts nothing.
      await sendLineToAgent(page, pull(run.url, 9, "files"), commentedIn(9), "Name the change.");
      await expect.poll(() => statesOf(run.home, 9), { timeout: 60_000 }).toEqual(["ready"]);
      holdAt(run.home, "fix-push", true);
      await app.open(pull(run.url, 9, "fixes"));
      const ready9 = screen.getByRole("article", "Fix 1 comment: Ready to review");
      await expect(ready9.getByRole("button", "Push")).toBeEnabled({ timeout: 30_000 });
      await ready9.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 9), { timeout: 30_000 }).toEqual(["pushing"]);
      await screen.getByRole("button", "Stop agent").tap();
      await expect.poll(() => sessionOf(run.home, 9)?.ended, { timeout: 30_000 }).toBe("stopped");
      holdAt(run.home, "fix-push", false);
      await expect.poll(() => statesOf(run.home, 9), { timeout: 30_000 }).toEqual(["ready"]);
      const runs = claude.runs().length;
      await ready9.getByRole("button", "Ask the agent to change").tap();
      await screen
        .getByRole("textbox", "What should the agent change?")
        .fill("Say why it starts here.");
      await screen
        .getByRole("form", "Ask the agent to change")
        .getByRole("button", "Send to the agent")
        .tap();
      await expect(
        screen.getByRole("form", "Ask the agent to change").getByRole("alert"),
      ).toHaveText(
        "The agent is stopped. Push or discard these changes, or send the comments again.",
        {
          timeout: 30_000,
        },
      );
      expect(statesOf(run.home, 9)).toEqual(["ready"]);
      expect(sessionOf(run.home, 9)?.ended).toBe("stopped");
      expect(claude.runs().length).toBe(runs);
      expect(NodeFS.existsSync(checkoutOf(run.home, 9))).toBe(false);
      await screenshotLightAndDark(app, browser, "change-in-ended-session");
      await screen.getByRole("form", "Ask the agent to change").getByRole("button", "Cancel").tap();

      // #9 again: prkit dies while that push runs, so the next start puts the fix back to ready in
      // the ended session. A Push that then finds the branch moved queues nothing there either.
      holdAt(run.home, "fix-push", true);
      await ready9.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 9), { timeout: 30_000 }).toEqual(["pushing"]);
      process.kill(run.serverPid, "SIGKILL");
      await expect.poll(() => isAlive(run.pid), { timeout: 15_000 }).toBe(false);
      holdAt(run.home, "fix-push", false);
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      expect(statesOf(run.home, 9)).toEqual(["ready"]);
      const moved9 = git.commit(9, { "src/limits.ts": "export const limits = {};\n" });
      await app.open(pull(run.url, 9, "fixes"));
      await ready9.getByRole("button", "Push").tap();
      await expect(screen.getByText("The branch moved")).toBeVisible({ timeout: 30_000 });
      expect(turnsOf(run.home, 9).map((turn) => [turn.state, turn.message])).toEqual([
        ["discarded", notRedone(moved9)],
      ]);
      expect(draftsOf(run.home, 9)).toEqual([{ state: "draft", turn: null }]);
    } finally {
      if (home !== "") holdAt(home, "fix-push", false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      fake.stop();
    }
  },
);
