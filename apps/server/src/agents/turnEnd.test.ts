import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  agentRow,
  endTurn,
  parseProcesses,
  type ProcessHost,
  ProcessesUnreadable,
  type ProcessRow,
  readEnvironments,
  recordDescendants,
  recordMarked,
  turnProcesses,
  turnRecord,
  unchecked,
} from "./turnEnd.ts";

const TURN = "3f6c2a9e-turn";
const PRKIT = 500;
/** The turn started two minutes ago. */
const WINDOW = 121;

// While the turn runs: prkit is 500 and the agent 700, in a group of its own. The agent's
// command runs in 710's session, where `npm test` (720) started a server (730). The owner's
// editor (900) has been open since before the turn.
const RUNNING = `
    1     0     1 11-06:35:25 Thu Oct  1 15:00:00 2026
  500     1   500    02:10:00 Tue Oct 13 10:00:00 2026
  700   500   700       00:55 Tue Oct 13 12:09:15 2026
  710   700   710       00:10 Tue Oct 13 12:10:00 2026
  720   710   710       00:05 Tue Oct 13 12:10:05 2026
  730   720   710       00:04 Tue Oct 13 12:10:06 2026
  900     1   900       10:00 Tue Oct 13 12:00:10 2026
`;

// After the agent and the command's shell (710) are gone. 600 is prkit's git, 550 another
// turn's agent, 560 a job of that other turn. 720 and 730 are still in 710's group; 750 is a
// `sleep` the shell left there, and 740 a job the server started in a session of its own.
// 800 is a detached node job launchd adopted, with a child 810. 650 is a group older than the
// turn: 660 is a turn job that joined it, 670 is not the turn's. The owner's editor (900)
// started a language server (910) and a helper for another project (920) during the turn.
// The owner opened a shell (1010) in the checkout from their terminal (1000) and ran a job
// (1020) in it.
const ENDED = `
    1     0     1 11-06:35:25 Thu Oct  1 15:00:00 2026
  500     1   500    02:10:00 Tue Oct 13 10:00:00 2026
  600   500   600       00:02 Tue Oct 13 12:11:08 2026
  550   500   550       01:50 Tue Oct 13 12:09:20 2026
  560     1   560       01:40 Tue Oct 13 12:09:30 2026
  720     1   710       01:05 Tue Oct 13 12:10:05 2026
  730   720   710       01:04 Tue Oct 13 12:10:06 2026
  740   730   740       00:30 Tue Oct 13 12:10:40 2026
  750     1   710       01:00 Tue Oct 13 12:10:10 2026
  800     1   800       00:40 Tue Oct 13 12:10:30 2026
  810   800   800       00:39 Tue Oct 13 12:10:31 2026
  650     1   650       05:00 Tue Oct 13 12:06:10 2026
  660   650   650       00:50 Tue Oct 13 12:10:20 2026
  670   650   650       00:45 Tue Oct 13 12:10:25 2026
  900     1   900       10:00 Tue Oct 13 12:00:10 2026
  910   900   900       00:30 Tue Oct 13 12:10:40 2026
  920   900   900       00:25 Tue Oct 13 12:10:45 2026
 1000     1  1000       20:00 Tue Oct 13 11:50:10 2026
 1010  1000  1010       00:20 Tue Oct 13 12:10:50 2026
 1020  1010  1020       00:15 Tue Oct 13 12:10:55 2026
`;

// What `ps -ww -o pid=,command=` prints for what started in the turn and isn't tied to it
// yet, and what `ps -E` adds after it. macOS shows no environment for its own programs, such
// as 750's sleep.
const COMMANDS: ReadonlyArray<readonly [number, string, string]> = [
  [560, "/usr/local/bin/node worker.js", "HOME=/Users/octocat PRKIT_TURN=another-turn"],
  [740, "/bin/sleep 600", ""],
  [750, "/bin/sleep 300", ""],
  [
    800,
    "/usr/local/bin/node -e setTimeout(()=>{},300000)",
    `HOME=/Users/octocat PRKIT_TURN=${TURN} TMPDIR=/tmp/t`,
  ],
  [810, "/bin/sleep 300", ""],
  [660, "/usr/bin/python3 -c import time", `PRKIT_TURN=${TURN}`],
  [670, "/usr/local/bin/node server.js", "HOME=/Users/octocat"],
  [910, "/usr/local/bin/node tsserver.js", `PRKIT_TURN=${TURN}x`],
  [920, "/usr/local/bin/node helper.js", "HOME=/Users/octocat"],
  [1010, "-zsh", ""],
  [1020, "/usr/local/bin/node dev.js echo PRKIT_TURN=another-turn", "HOME=/Users/octocat"],
];
const psOutput = (
  commands: ReadonlyArray<readonly [number, string, string]>,
  environment: boolean,
) =>
  commands
    .map(
      ([pid, command, env]) =>
        `  ${pid} ${environment && env !== "" ? `${command} ${env}` : command}`,
    )
    .join("\n");
const ENVIRONMENTS = readEnvironments(psOutput(COMMANDS, false), psOutput(COMMANDS, true), TURN);

/** What prkit ties to the turn: the agent's descendants while it ran, then the marked processes. */
const leftOver = () => {
  const record = turnRecord(TURN, 0);
  recordDescendants(record, parseProcesses(RUNNING), 700);
  const rows = parseProcesses(ENDED);
  recordMarked(record, unchecked(record, rows, PRKIT, WINDOW), ENVIRONMENTS);
  return turnProcesses(record, rows, PRKIT, WINDOW);
};

describe("turnProcesses", () => {
  it("leaves a language server and a helper the owner's open editor started during the turn", () => {
    expect(leftOver()).not.toContain(900);
    expect(leftOver()).not.toContain(910);
    expect(leftOver()).not.toContain(920);
  });

  it("leaves a shell the owner opened in the checkout during the turn, and its job", () => {
    expect(leftOver()).not.toContain(1010);
    expect(leftOver()).not.toContain(1020);
  });

  it("ends a job that carries the turn's mark after launchd adopted it, with its child", () => {
    expect(leftOver()).toEqual(expect.arrayContaining([800, 810]));
  });

  it("ends a turn job in a group whose leader started before the turn, but nothing else in that group", () => {
    expect(leftOver()).toContain(660);
    expect(leftOver()).not.toContain(650);
    expect(leftOver()).not.toContain(670);
  });

  it("ends what prkit saw under the agent's command after the shell exited, and what that started", () => {
    expect(leftOver()).toEqual(expect.arrayContaining([720, 730, 740]));
  });

  it("doesn't count a group as the turn's once its leader is gone", () => {
    expect(leftOver()).not.toContain(750);
  });

  it("leaves prkit's own git and another turn's processes", () => {
    expect(leftOver()).toEqual([660, 720, 730, 740, 800, 810]);
  });
});

describe("recordDescendants", () => {
  it("ties the agent and everything under it to the turn, and the groups they lead", () => {
    const record = turnRecord(TURN, 0);
    recordDescendants(record, parseProcesses(RUNNING), 700);
    expect([...record.processes].map(([pid, process]) => [pid, process.leader]).toSorted()).toEqual(
      [
        [700, true],
        [710, true],
        [720, false],
        [730, false],
      ],
    );
  });
});

describe("readEnvironments", () => {
  it("finds this turn's mark in a process's arguments or environment, and no other turn's", () => {
    expect([...ENVIRONMENTS.marked].toSorted()).toEqual([660, 800]);
  });

  it("knows which processes ps showed an environment for", () => {
    expect([...ENVIRONMENTS.shown].toSorted((a, b) => a - b)).toEqual([
      560, 660, 670, 800, 910, 920, 1020,
    ]);
  });
});

describe("recordMarked", () => {
  it("looks again at a process ps showed no environment for, and ties it once it shows the mark", () => {
    const record = turnRecord(TURN, 0);
    const rows = parseProcesses(ENDED);
    const wrapper: ReadonlyArray<readonly [number, string, string]> = [
      [740, "/bin/sh -c npm start", ""],
    ];
    recordMarked(
      record,
      unchecked(record, rows, PRKIT, WINDOW),
      readEnvironments(psOutput(wrapper, false), psOutput(wrapper, true), TURN),
    );
    expect(unchecked(record, rows, PRKIT, WINDOW).map((row) => row.pid)).toContain(740);
    const exec: ReadonlyArray<readonly [number, string, string]> = [
      [740, "/usr/local/bin/node server.js", `PRKIT_TURN=${TURN}`],
    ];
    recordMarked(
      record,
      unchecked(record, rows, PRKIT, WINDOW),
      readEnvironments(psOutput(exec, false), psOutput(exec, true), TURN),
    );
    expect(turnProcesses(record, rows, PRKIT, WINDOW)).toContain(740);
  });

  it("doesn't look again at a process whose environment ps showed without the mark", () => {
    const record = turnRecord(TURN, 0);
    const rows = parseProcesses(ENDED);
    recordMarked(record, unchecked(record, rows, PRKIT, WINDOW), ENVIRONMENTS);
    expect(unchecked(record, rows, PRKIT, WINDOW).map((row) => row.pid)).not.toContain(670);
  });
});

describe("agentRow", () => {
  it("follows the agent by the start the first look saw, and never a process that reuses its pid", () => {
    const agent = { pid: 700, started: null };
    expect(agentRow(agent, parseProcesses(RUNNING))?.started).toBe("Tue Oct 13 12:09:15 2026");
    const reused = parseProcesses(`  700   900   900       00:01 Tue Oct 13 12:11:09 2026`);
    expect(agentRow(agent, reused)).toBeNull();
    expect(agentRow(agent, parseProcesses(RUNNING))).toBeNull();
  });
});

describe("parseProcesses", () => {
  it("reads ps's elapsed time in days, hours, minutes and seconds, and the start", () => {
    const [launchd, prkit] = parseProcesses(RUNNING);
    expect([launchd?.seconds, prkit?.seconds, prkit?.started]).toEqual([
      974_125,
      7_800,
      "Tue Oct 13 10:00:00 2026",
    ]);
  });
});

const SELF = `  500     1   500    02:10:00 Tue Oct 13 10:00:00 2026`;
const row = (line: string): ProcessRow => {
  const [parsed] = parseProcesses(line);
  if (parsed === undefined) throw new Error(`not a ps line: ${line}`);
  return parsed;
};
const job = (pid: number) =>
  row(`  ${pid}     1   ${pid}       00:10 Tue Oct 13 12:10:${pid % 60} 2026`);

/** A machine whose `ps` prints `lists` in turn (the last one from then on); `marked` carry the mark. */
const scripted = (
  lists: ReadonlyArray<ReadonlyArray<ProcessRow> | "fails">,
  marked: (pid: number) => boolean,
) => {
  const log: Array<string> = [];
  const at = { call: 0 };
  const host: ProcessHost = {
    list: Effect.suspend(() => {
      const next = lists[Math.min(at.call++, lists.length - 1)] ?? [];
      return next === "fails"
        ? Effect.fail(new ProcessesUnreadable({ message: "ps: Operation not permitted" }))
        : Effect.succeed([row(SELF), ...next]);
    }),
    environments: (pids) =>
      Effect.succeed({ shown: new Set(pids), marked: new Set(pids.filter(marked)) }),
    signal: (pid, signal) => Effect.sync(() => log.push(`${signal} ${pid}`)),
    pause: (duration) => Effect.sync(() => log.push(`wait ${Duration.toMillis(duration)}`)),
  };
  return { host, log };
};

describe("endTurn", () => {
  it("asks a leftover to stop, kills it if it is still there half a second later, and reports the turn ended", async () => {
    const { host, log } = scripted([[job(800)], [job(800)], []], () => true);
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0), PRKIT));
    expect(end).toEqual({ _tag: "ended" });
    expect(log).toEqual(["SIGTERM 800", "wait 500", "SIGKILL 800", "wait 100"]);
  });

  it("reports the turn unfinished when leftovers keep turning up after five rounds", async () => {
    const { host } = scripted(
      [[job(801)], [job(802)], [job(803)], [job(804)], [job(805)], [job(806)]],
      () => true,
    );
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0), PRKIT));
    expect(end).toMatchObject({ _tag: "unfinished", reason: "processes 806 kept running" });
  });

  it("reports the turn unfinished when prkit can't list the processes", async () => {
    const { host, log } = scripted([[job(800)], "fails"], () => true);
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0), PRKIT));
    expect(end).toEqual({
      _tag: "unfinished",
      reason: "prkit couldn't list processes: ps: Operation not permitted",
      processes: [{ pid: 800, started: job(800).started, leader: true }],
    });
    expect(log).toEqual(["SIGTERM 800", "wait 500"]);
  });

  it("reports the turn unfinished when a look while the agent ran couldn't list the processes", async () => {
    const { host } = scripted([[]], () => true);
    const record = turnRecord(TURN, 0);
    record.failures.push("ps took too long");
    const end = await Effect.runPromise(endTurn(host, record, PRKIT));
    expect(end).toMatchObject({
      _tag: "unfinished",
      reason: "prkit couldn't list processes while the agent ran: ps took too long",
    });
  });

  it("on a later try, ends what prkit tied to the turn before, even without the mark", async () => {
    const { host, log } = scripted([[job(800), job(801)], []], () => false);
    const before = [{ pid: 800, started: job(800).started, leader: true }];
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0, before), PRKIT));
    expect(end).toEqual({ _tag: "ended" });
    expect(log).toEqual(["SIGTERM 800", "wait 500"]);
  });

  it("after a restart, with nothing recorded while the agent ran, ends the turn's jobs by the mark alone", async () => {
    const { host, log } = scripted([[job(800), job(801)], [job(801)]], (pid) => pid === 800);
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0), PRKIT));
    expect(end).toEqual({ _tag: "ended" });
    expect(log).toEqual(["SIGTERM 800", "wait 500"]);
  });

  it("leaves a process without the mark that prkit never saw under the agent", async () => {
    const { host, log } = scripted([[job(800)]], () => false);
    const end = await Effect.runPromise(endTurn(host, turnRecord(TURN, 0), PRKIT));
    expect(end).toEqual({ _tag: "ended" });
    expect(log).toEqual([]);
  });
});
