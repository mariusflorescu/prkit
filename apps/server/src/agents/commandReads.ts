import { parse, type SimpleCommand } from "./bashPolicy.ts";
import { RG_VALUE_FLAGS } from "./programs.ts";

/** Lines of a file an agent saw: all of it, a range, or the last few. */
export type LineSpan =
  | { readonly _tag: "all" }
  | { readonly _tag: "range"; readonly start: number; readonly end: number }
  | { readonly _tag: "last"; readonly count: number };

/** A file a tool call printed for the agent. Paths are as the agent wrote them. */
export interface FileRead {
  readonly path: string;
  readonly lines: LineSpan;
}

export interface CommandSummary {
  /** In plain words, with paths shown relative to the checkout: "Read src/store.js". */
  readonly label: string;
  readonly reads: ReadonlyArray<FileRead>;
}

const ALL: LineSpan = { _tag: "all" };
const SHELLS = new Set(["sh", "bash", "zsh"]);
const IGNORED = new Set(["cd", "echo", "printf", "true", "pwd"]);
const REVISION = /^(HEAD|FETCH_HEAD|ORIG_HEAD|[0-9a-f]{7,40})([~^]\d*)*$|\.\./;

const HEAD_VALUE_FLAGS = new Set(["-n", "--lines", "-c", "--bytes"]);

const basename = (program: string) => program.slice(program.lastIndexOf("/") + 1);
/** The arguments that aren't flags or a flag's value. */
const operands = (args: ReadonlyArray<string>, valueFlags: ReadonlySet<string> = new Set()) =>
  args.filter((arg, index) => !arg.startsWith("-") && !valueFlags.has(args[index - 1] ?? ""));
const quoted = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);
const list = (paths: ReadonlyArray<string>) =>
  paths.length <= 2
    ? paths.join(", ")
    : `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more`;
const spanLabel = (lines: LineSpan) =>
  lines._tag === "range"
    ? `, lines ${lines.start}-${lines.end}`
    : lines._tag === "last"
      ? `, last ${lines.count} lines`
      : "";

/** `head -n 20`, `head -20`, `head --lines=20`: the count, or 10. */
const headCount = (args: ReadonlyArray<string>) => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const value =
      arg === "-n" || arg === "--lines"
        ? args[index + 1]
        : (/^-n?(\d+)$/.exec(arg)?.[1] ?? /^--lines=(\d+)$/.exec(arg)?.[1]);
    if (value !== undefined && /^\d+$/.test(value)) return Number(value);
  }
  return 10;
};

/** `sed -n '12,40p'` or `sed -n 12p`: the printed range, else null. */
const sedRange = (args: ReadonlyArray<string>): LineSpan | null => {
  if (!args.includes("-n")) return null;
  const script = args.find((arg) => /^\d+(,\d+)?p$/.test(arg));
  const match = script === undefined ? null : /^(\d+)(?:,(\d+))?p$/.exec(script);
  if (match === null) return null;
  const start = Number(match[1]);
  return { _tag: "range", start, end: match[2] === undefined ? start : Number(match[2]) };
};

/** Paths a git command shows the content of. `rev:path` counts as the path. */
const gitReads = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [subcommand = "", ...rest] = args;
  const dashDash = rest.indexOf("--");
  const afterDashDash = dashDash === -1 ? [] : rest.slice(dashDash + 1);
  const before = operands(dashDash === -1 ? rest : rest.slice(0, dashDash));
  switch (subcommand) {
    case "show":
      return [
        ...before.flatMap((arg) => (arg.includes(":") ? [arg.slice(arg.indexOf(":") + 1)] : [])),
        ...afterDashDash,
      ];
    case "diff":
    case "blame":
      return [...before.filter((arg) => !REVISION.test(arg)), ...afterDashDash];
    case "log":
      return rest.includes("-p") || rest.includes("--patch") ? afterDashDash : [];
    default:
      return [];
  }
};

const gitLabel = (
  args: ReadonlyArray<string>,
  reads: ReadonlyArray<string>,
  show: (path: string) => string,
) => {
  const [subcommand = ""] = args;
  const shown = list(reads.map(show));
  switch (subcommand) {
    case "show":
      return reads.length > 0
        ? args.some((arg) => arg.includes(":"))
          ? `Read the earlier version of ${shown}`
          : `Read a commit's change to ${shown}`
        : "Read a commit";
    case "diff":
      return reads.length > 0 ? `Read the change to ${shown}` : "Read the change";
    case "log":
      return reads.length > 0 ? `Read the history of ${shown}` : "Read the commit history";
    case "blame":
      return `Read who last changed ${shown}`;
    case "ls-files":
      return "Listed the repository's files";
    default:
      return "Looked up commits";
  }
};

/** One pipeline: the first command produces output, later ones can narrow the lines. */
const describePipeline = (
  pipeline: ReadonlyArray<SimpleCommand>,
  show: (path: string) => string,
): CommandSummary | null => {
  const [first, ...rest] = pipeline;
  if (first === undefined) return null;
  const [rawProgram = "", ...args] = first.words;
  const program = basename(rawProgram);
  if (IGNORED.has(program)) return null;
  const narrowed = rest.reduce<LineSpan | null>((span, command) => {
    const [next = "", ...nextArgs] = command.words;
    if (basename(next) === "sed") return sedRange(nextArgs) ?? span;
    if (basename(next) === "head") return { _tag: "range", start: 1, end: headCount(nextArgs) };
    return span;
  }, null);
  const fileRead = (paths: ReadonlyArray<string>, lines: LineSpan): CommandSummary => {
    const reads = paths.map((path) => ({ path, lines }));
    return {
      label:
        paths.length === 0
          ? `Read ${program} output`
          : `Read ${list(paths.map(show))}${paths.length === 1 ? spanLabel(lines) : ""}`,
      reads,
    };
  };
  switch (program) {
    case "cat":
    case "nl":
      return fileRead(operands(args), narrowed ?? ALL);
    case "head":
      return fileRead(operands(args, HEAD_VALUE_FLAGS), {
        _tag: "range",
        start: 1,
        end: headCount(args),
      });
    case "tail":
      return fileRead(operands(args, HEAD_VALUE_FLAGS), { _tag: "last", count: headCount(args) });
    case "sed": {
      const range = sedRange(args);
      const files = operands(args, new Set(["-e"])).filter((arg) => !/^\d+(,\d+)?p$/.test(arg));
      return range === null
        ? { label: `Ran sed on ${list(files.map(show))}`, reads: [] }
        : fileRead(files, range);
    }
    case "git": {
      const reads = gitReads(args);
      return {
        label: gitLabel(args, reads, show),
        reads: reads.map((path) => ({ path, lines: ALL })),
      };
    }
    case "rg":
    case "grep": {
      const flagged = args.findIndex((arg) => arg === "-e" || arg === "--regexp");
      const words = operands(args, RG_VALUE_FLAGS);
      const pattern = flagged === -1 ? (words[0] ?? "") : (args[flagged + 1] ?? "");
      const paths = flagged === -1 ? words.slice(1) : words;
      return {
        label: `Searched for ${quoted(pattern)}${paths.length === 0 ? "" : ` in ${list(paths.map(show))}`}`,
        reads: [],
      };
    }
    case "ls":
    case "find":
    case "tree": {
      const paths = operands(args).filter((arg) => program !== "find" || !arg.startsWith("("));
      const where = program === "find" ? paths.slice(0, 1) : paths;
      return {
        label: where.length === 0 ? "Listed files" : `Listed files in ${list(where.map(show))}`,
        reads: [],
      };
    }
    case "wc":
      return { label: `Counted lines in ${list(operands(args).map(show))}`, reads: [] };
    default:
      return { label: `Ran ${program}`, reads: [] };
  }
};

/**
 * What a shell command did, from its parsed program and file arguments instead of
 * the raw command line. A login-shell wrapper (`zsh -lc '...'`) is unwrapped.
 * Null when the command can't be parsed (expansion, redirection, subshells).
 */
export const describeCommand = (
  command: string,
  show: (path: string) => string,
): CommandSummary | null => {
  const parsed = parse(command);
  if (parsed._tag === "error") return null;
  const [only] = parsed.commands;
  const [shell = "", flag = "", script] = only?.words ?? [];
  if (
    parsed.commands.length === 1 &&
    SHELLS.has(basename(shell)) &&
    (flag === "-c" || flag === "-lc") &&
    script !== undefined
  )
    return describeCommand(script, show);
  const pipelines: Array<Array<SimpleCommand>> = [];
  for (const simple of parsed.commands) {
    const current = pipelines.at(-1);
    if (simple.piped && current !== undefined) current.push(simple);
    else pipelines.push([simple]);
  }
  const summaries = pipelines.flatMap((pipeline) => {
    const summary = describePipeline(pipeline, show);
    return summary === null ? [] : [summary];
  });
  const [first, ...others] = summaries;
  if (first === undefined) return null;
  return {
    label: others.length === 0 ? first.label : `${first.label} (and ${others.length} more)`,
    reads: summaries.flatMap((summary) => summary.reads),
  };
};
