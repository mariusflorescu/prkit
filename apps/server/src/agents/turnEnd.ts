import { childEnv } from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Every agent turn's processes start with `PRKIT_TURN=<the turn's id>` in their environment. */
export const TURN_MARKER = "PRKIT_TURN";

/**
 * A process prkit tied to a turn, as it was then. Its pid and start name it even after the
 * pid is reused.
 */
export const TurnProcess = Schema.Struct({
  pid: Schema.Int,
  started: Schema.String,
  /** It led its process group, so every process in that group is the turn's too. */
  leader: Schema.Boolean,
});
export type TurnProcess = typeof TurnProcess.Type;

/** prkit couldn't make sure that everything it tied to a turn has ended: why, and what it tied. */
export const Unfinished = Schema.TaggedStruct("unfinished", {
  reason: Schema.String,
  processes: Schema.Array(TurnProcess),
});
export type Unfinished = typeof Unfinished.Type;

/** How an agent turn ended: everything prkit tied to it is gone, or prkit couldn't make sure. */
export type TurnEnd = { readonly _tag: "ended" } | Unfinished;

/** A turn as its agent runs it: the id its processes carry, and where its end is reported. */
export interface AgentTurn {
  readonly id: string;
  readonly ended: (end: TurnEnd) => Effect.Effect<void>;
}

/**
 * A process in `ps -A -o pid=,ppid=,pgid=,etime=,lstart=`. A pid and its start time name
 * one process even after the pid is reused.
 */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Seconds alive. */
  readonly seconds: number;
  /** When it started, as `ps` prints it. */
  readonly started: string;
}

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
const elapsedSeconds = (etime: string) => {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (clock ?? "").split(":").map(Number);
  return Number(days) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0);
};

export const parseProcesses = (output: string): ReadonlyArray<ProcessRow> =>
  output.split("\n").flatMap((line) => {
    const [pid, ppid, pgid, etime, ...started] = line.trim().split(/\s+/);
    if (pid === undefined || ppid === undefined || pgid === undefined || etime === undefined)
      return [];
    const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) };
    const seconds = elapsedSeconds(etime);
    return Object.values(row).every(Number.isInteger) &&
      Number.isFinite(seconds) &&
      started.length > 0
      ? [{ ...row, seconds, started: started.join(" ") }]
      : [];
  });

/** `ps -o pid=,command=` lines by pid. */
const commandLines = (output: string) =>
  new Map(
    output.split("\n").flatMap((line) => {
      const [, pid, command] = /^\s*(\d+) (.*)$/.exec(line.trimEnd()) ?? [];
      return pid === undefined || command === undefined ? [] : [[Number(pid), command.trim()]];
    }),
  );

/** What `ps -E` showed of some processes' environments. */
export interface Environments {
  /** The processes whose environment it showed. */
  readonly shown: ReadonlySet<number>;
  /** The processes whose arguments or environment hold the turn's marker. */
  readonly marked: ReadonlySet<number>;
}

/**
 * Reads `ps -E -ww -o pid=,command=` next to `ps -ww -o pid=,command=` for the same
 * processes: a process's environment was shown when its line is the plain one with more
 * after it. macOS shows no environment for its own programs (`/bin`, `/usr/bin`), so a `sleep`
 * or `sh` never shows the marker even when it has it, and a process that `exec`s changes
 * what is shown.
 */
export const readEnvironments = (plain: string, withEnvironment: string, turn: string) => {
  const mark = `${TURN_MARKER}=${turn}`;
  const commands = commandLines(plain);
  const shown = new Set<number>();
  const marked = new Set<number>();
  for (const [pid, line] of commandLines(withEnvironment)) {
    const command = commands.get(pid);
    if (command !== undefined && line.startsWith(`${command} `)) shown.add(pid);
    if (line.split(/\s+/).includes(mark)) marked.add(pid);
  }
  return { shown, marked } satisfies Environments;
};

/** What prkit tied to one turn while it ran and after. */
export interface TurnRecord {
  readonly turn: string;
  /** When the turn started, in epoch milliseconds. */
  readonly since: number;
  /** The turn's processes by pid: the agent's descendants, and processes carrying the marker. */
  readonly processes: Map<number, TurnProcess>;
  /** `<pid> <start>` of every process whose environment `ps` showed, marked or not. */
  readonly checked: Set<string>;
  /** Why looks while the agent ran couldn't list the processes. */
  readonly failures: Array<string>;
}

/** A turn's record, with what prkit tied to it before, if a sweep of it ever came up unfinished. */
export const turnRecord = (
  turn: string,
  since: number,
  processes: ReadonlyArray<TurnProcess> = [],
): TurnRecord => ({
  turn,
  since,
  processes: new Map(processes.map((tied) => [tied.pid, tied])),
  checked: new Set(),
  failures: [],
});

const isTied = (record: TurnRecord, row: ProcessRow) =>
  record.processes.get(row.pid)?.started === row.started;

const tie = (record: TurnRecord, row: ProcessRow) => {
  const known = isTied(record, row) && record.processes.get(row.pid)?.leader === true;
  record.processes.set(row.pid, {
    pid: row.pid,
    started: row.started,
    leader: known || row.pid === row.pgid,
  });
};

/** Ties the agent and every process now descending from it to the turn. */
export const recordDescendants = (
  record: TurnRecord,
  rows: ReadonlyArray<ProcessRow>,
  agent: number,
) => {
  const children = new Map<number, Array<ProcessRow>>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const queue = rows.filter((row) => row.pid === agent);
  const visited = new Set<number>();
  for (let row = queue.pop(); row !== undefined; row = queue.pop()) {
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    tie(record, row);
    queue.push(...(children.get(row.pid) ?? []));
  }
};

/**
 * The processes started in the turn's last `seconds` that aren't prkit's: a process whose
 * parents lead to prkit (`self`) without passing one of the turn's is prkit's own git or
 * another turn's agent.
 */
const startedInTurn = (
  record: TurnRecord,
  rows: ReadonlyArray<ProcessRow>,
  self: number,
  seconds: number,
) => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const isPrkits = (row: ProcessRow) => {
    const seen = new Set<number>();
    for (let at: ProcessRow | undefined = row; at !== undefined; at = byPid.get(at.ppid)) {
      if (isTied(record, at)) return false;
      if (at.pid === self) return true;
      if (at.pid <= 1 || seen.has(at.pid)) return false;
      seen.add(at.pid);
    }
    return false;
  };
  return rows.filter((row) => row.seconds <= seconds && !isPrkits(row));
};

/**
 * The processes started in the turn that prkit hasn't tied to it, nor seen the environment of.
 * One whose environment `ps` didn't show is looked at again every time.
 */
export const unchecked = (
  record: TurnRecord,
  rows: ReadonlyArray<ProcessRow>,
  self: number,
  seconds: number,
) =>
  startedInTurn(record, rows, self, seconds).filter(
    (row) => !isTied(record, row) && !record.checked.has(`${row.pid} ${row.started}`),
  );

/** Ties the checked processes that hold the marker to the turn, and notes whose environment it saw. */
export const recordMarked = (
  record: TurnRecord,
  checked: ReadonlyArray<ProcessRow>,
  environments: Environments,
) => {
  for (const row of checked) {
    if (environments.shown.has(row.pid)) record.checked.add(`${row.pid} ${row.started}`);
    if (environments.marked.has(row.pid)) tie(record, row);
  }
};

/**
 * What the turn left running: the processes started in it that prkit tied to it, the ones
 * they parent, and the members of a group one of them leads. A group counts as a whole only
 * while its leader is the very process prkit tied, so not one that started before the turn,
 * nor one whose leader is gone.
 */
export const turnProcesses = (
  record: TurnRecord,
  rows: ReadonlyArray<ProcessRow>,
  self: number,
  seconds: number,
) => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const leads = (pgid: number) => {
    const leader = record.processes.get(pgid);
    const now = byPid.get(pgid);
    return leader?.leader === true && now?.started === leader.started;
  };
  const fresh = startedInTurn(record, rows, self, seconds);
  const found = new Set(
    fresh.filter((row) => isTied(record, row) || leads(row.pgid)).map((row) => row.pid),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const row of fresh) {
      if (found.has(row.pid) || !found.has(row.ppid)) continue;
      found.add(row.pid);
      grew = true;
    }
  }
  return [...found].toSorted((a, b) => a - b);
};

export class ProcessesUnreadable extends Schema.TaggedError<ProcessesUnreadable>()(
  "ProcessesUnreadable",
  { message: Schema.String },
) {}

/** How prkit lists, checks and signals processes. */
export interface ProcessHost {
  readonly list: Effect.Effect<ReadonlyArray<ProcessRow>, ProcessesUnreadable>;
  readonly environments: (
    pids: ReadonlyArray<number>,
    turn: string,
  ) => Effect.Effect<Environments, ProcessesUnreadable>;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
  readonly pause: (duration: Duration.Duration) => Effect.Effect<void>;
}

const NONE: Environments = { shown: new Set(), marked: new Set() };

/**
 * `ps` on this machine. Every call names prkit itself too, and output that doesn't show it,
 * or a `ps` that fails, counts as unreadable.
 */
export const processHost = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ps = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("ps", args, {
            env: childEnv(process.env),
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
        const code = yield* child.exitCode;
        if (code !== 0)
          return yield* new ProcessesUnreadable({ message: `ps exited with code ${code}` });
        return output;
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        PlatformError: (error) => Effect.fail(new ProcessesUnreadable({ message: error.message })),
        TimeoutError: () => Effect.fail(new ProcessesUnreadable({ message: "ps took too long" })),
      }),
    );
  const showsSelf = (output: string) => commandLines(output).has(process.pid);
  const host: ProcessHost = {
    list: ps(["-A", "-o", "pid=,ppid=,pgid=,etime=,lstart="]).pipe(
      Effect.map(parseProcesses),
      Effect.filterOrFail(
        (rows) => rows.some((row) => row.pid === process.pid),
        () => new ProcessesUnreadable({ message: "ps didn't list prkit itself" }),
      ),
    ),
    environments: (pids, turn) => {
      if (pids.length === 0) return Effect.succeed(NONE);
      const asked = [process.pid, ...pids].join(",");
      return Effect.all([
        ps(["-ww", "-o", "pid=,command=", "-p", asked]),
        ps(["-E", "-ww", "-o", "pid=,command=", "-p", asked]),
      ]).pipe(
        Effect.filterOrFail(
          ([plain, withEnvironment]) => showsSelf(plain) && showsSelf(withEnvironment),
          () => new ProcessesUnreadable({ message: "ps didn't show prkit itself" }),
        ),
        Effect.map(([plain, withEnvironment]) => readEnvironments(plain, withEnvironment, turn)),
      );
    },
    signal: (pid, signal) =>
      Effect.sync(() => {
        try {
          process.kill(pid, signal);
        } catch {
          // Gone already, or not prkit's to signal: the next look finds it if it stayed.
        }
      }),
    pause: Effect.sleep,
  };
  return host;
});

/** The agent prkit follows: its pid, and its start from the first look that saw it. */
export interface FollowedAgent {
  pid: number | null;
  started: string | null;
}

/**
 * The agent's row in a look, while it runs. The first look after `follow` pins its start; once
 * a look doesn't find that process, prkit stops following the pid, which may name another
 * process from then on.
 */
export const agentRow = (agent: FollowedAgent, rows: ReadonlyArray<ProcessRow>) => {
  if (agent.pid === null) return null;
  const row = rows.find((candidate) => candidate.pid === agent.pid);
  if (row === undefined || (agent.started !== null && agent.started !== row.started)) {
    agent.pid = null;
    return null;
  }
  agent.started = row.started;
  return row;
};

/** Looks at the processes once: ties the agent's descendants (while it runs) and the marked ones. */
const look = (host: ProcessHost, record: TurnRecord, self: number, agent: FollowedAgent | null) =>
  Effect.gen(function* () {
    const rows = yield* host.list;
    const seconds = Math.ceil(((yield* Clock.currentTimeMillis) - record.since) / 1000) + 1;
    const followed = agent === null ? null : agentRow(agent, rows);
    if (followed !== null) recordDescendants(record, rows, followed.pid);
    const fresh = unchecked(record, rows, self, seconds);
    recordMarked(
      record,
      fresh,
      yield* host.environments(
        fresh.map((row) => row.pid),
        record.turn,
      ),
    );
    return { rows, seconds };
  });

const unfinished = (record: TurnRecord, reason: string): Unfinished => ({
  _tag: "unfinished",
  reason,
  processes: [...record.processes.values()],
});

const ROUNDS = 5;

/**
 * Ends what prkit tied to a turn once its agent is gone: TERM first, KILL for whatever is
 * still there half a second later, and another look for jobs a dying one started. Unfinished
 * when processes keep turning up after five rounds, or prkit can't read them now or couldn't
 * while the agent ran.
 */
export const endTurn = (host: ProcessHost, record: TurnRecord, self: number) =>
  Effect.gen(function* () {
    const asked = new Set<number>();
    for (let round = 0; ; round++) {
      const { rows, seconds } = yield* look(host, record, self, null);
      const pids = turnProcesses(record, rows, self, seconds);
      if (pids.length === 0) {
        const [failure] = record.failures;
        const end: TurnEnd =
          failure === undefined
            ? { _tag: "ended" }
            : unfinished(record, `prkit couldn't list processes while the agent ran: ${failure}`);
        return { end, ended: [...asked] };
      }
      if (round === ROUNDS)
        return {
          end: unfinished(record, `processes ${pids.join(", ")} kept running`),
          ended: [...asked],
        };
      const fresh = pids.filter((pid) => !asked.has(pid));
      for (const pid of pids) yield* host.signal(pid, asked.has(pid) ? "SIGKILL" : "SIGTERM");
      for (const pid of fresh) asked.add(pid);
      yield* host.pause(Duration.millis(fresh.length > 0 ? 500 : 100));
    }
  }).pipe(
    Effect.catchTag("ProcessesUnreadable", (error) =>
      Effect.succeed({
        end: unfinished(record, `prkit couldn't list processes: ${error.message}`),
        ended: [],
      }),
    ),
    Effect.tap(({ end, ended }) =>
      end._tag === "ended"
        ? ended.length === 0
          ? Effect.void
          : Effect.logInfo("Ended what the agent turn left running").pipe(
              Effect.annotateLogs({ turn: record.turn, pids: ended.join(" ") }),
            )
        : Effect.logWarning("Couldn't end what the agent turn left running").pipe(
            Effect.annotateLogs({ turn: record.turn, reason: end.reason }),
          ),
    ),
    Effect.map(({ end }) => end),
  );

const POLL = Duration.millis(250);

/**
 * Ties processes to an agent turn while it runs and, once the agent is gone, ends what the
 * turn left and reports how that went (docs/internals/fix-agent.md "Turn end"). Call it
 * before the agent starts: a scope's finalizers run in reverse, so this one runs after the
 * agent's own. `follow` names the agent's process once it has one.
 */
export const watchTurn = (turn: AgentTurn) =>
  Effect.gen(function* () {
    const host = yield* processHost;
    const record = turnRecord(turn.id, yield* Clock.currentTimeMillis);
    const agent: FollowedAgent = { pid: null, started: null };
    yield* Effect.addFinalizer(() =>
      endTurn(host, record, process.pid).pipe(Effect.flatMap(turn.ended)),
    );
    yield* Effect.suspend(() => look(host, record, process.pid, agent)).pipe(
      Effect.catchTag("ProcessesUnreadable", (error) =>
        Effect.sync(() => {
          record.failures.push(error.message);
        }),
      ),
      Effect.repeat(Schedule.spaced(POLL)),
      Effect.forkScoped,
    );
    return {
      follow: (pid: number) => {
        agent.pid = pid;
        agent.started = null;
      },
    };
  });
