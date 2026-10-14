import type { AgentAccess } from "./AgentProvider.ts";
import { PATTERN, type PathArgument } from "./checkoutPaths.ts";
import { PROGRAMS } from "./programs.ts";

/**
 * The read-only command allowlist for the agent's Bash tool
 * (docs/internals/architecture.md "Agents"). A command is allowed only if every
 * part of a pipeline or `&&`/`;` list is an allowed program with allowed
 * flags (`programs.ts`), and nothing in it can expand, redirect or run something else.
 */
export type BashDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/** A program by its name; `/bin/cat` and `/usr/bin/sed` are the system's own `cat` and `sed`. */
const programName = (word: string) => word.replace(/^\/(usr\/)?bin\/(?=[^/]+$)/, "");

/**
 * One simple command; `piped` when it reads the previous command's output through `|`.
 * `patterns` are the indexes of the words the shell expands against the file system
 * before it runs.
 */
export interface SimpleCommand {
  readonly words: ReadonlyArray<string>;
  readonly patterns: ReadonlySet<number>;
  readonly piped: boolean;
}

type Parsed =
  | { readonly _tag: "ok"; readonly commands: ReadonlyArray<SimpleCommand> }
  | {
      readonly _tag: "error";
      readonly reason: string;
    };

/** What may follow `2>&1`: the end, a blank, or what ends a command. */
const WORD_ENDS = new Set(["", " ", "\t", "\n", ";", "|", "&"]);

/** The characters a backslash escapes inside double quotes; before any other it stays. */
const QUOTED_ESCAPES = new Set(["$", "`", '"', "\\"]);

/**
 * Splits a command into simple commands on `|`, `||`, `&&`, `;` and newlines, honoring
 * quotes the way bash and zsh do. Anything the shells could read as other words than
 * these is refused: a line continuation, a NUL or carriage return, a `~` the shell
 * expands after `=` or `:`.
 */
export const parse = (command: string): Parsed => {
  const commands: Array<SimpleCommand> = [];
  let words: Array<string> = [];
  let patterns = new Set<number>();
  let word: string | null = null;
  let pattern = false;
  /** Where the word began in `command`, to tell a bare `2>&1` from a quoted `"2">&1`. */
  let wordStart = 0;
  /** The word's last character was an unquoted `=` or `:`, after which bash expands `~`. */
  let assigns = false;
  let piped = false;
  const endWord = () => {
    if (word !== null && pattern) patterns.add(words.length);
    if (word !== null) words.push(word);
    word = null;
    pattern = false;
    assigns = false;
  };
  const endCommand = (nextPiped = false) => {
    endWord();
    if (words.length > 0) commands.push({ words, patterns, piped });
    words = [];
    patterns = new Set();
    piped = nextPiped;
  };
  const append = (text: string, plain: boolean) => {
    word = (word ?? "") + text;
    assigns = plain && (text === "=" || text === ":");
  };
  const refuse = (what: string): Parsed => ({
    _tag: "error",
    reason: `${what} isn't allowed. Run plain read-only commands without expansion or redirection.`,
  });
  if (command.includes("\0") || command.includes("\r")) return refuse("A NUL or carriage return");
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    const next = command.charAt(index + 1);
    if (word === null) wordStart = index;
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return refuse("An unclosed quote");
      append(command.slice(index + 1, end), false);
      index = end;
    } else if (char === '"') {
      let value = "";
      index++;
      for (; index < command.length && command.charAt(index) !== '"'; index++) {
        const inner = command.charAt(index);
        const escaped = command.charAt(index + 1);
        if (inner === "$" || inner === "`") return refuse("Expansion");
        if (inner === "\\" && escaped === "\n") return refuse("A line continuation");
        if (inner === "\\" && QUOTED_ESCAPES.has(escaped)) value += command.charAt(++index);
        else value += inner;
      }
      if (index >= command.length) return refuse("An unclosed quote");
      append(value, false);
    } else if (char === "\\") {
      if (next === "" || next === "\n") return refuse("A line continuation");
      append(command.charAt(++index), false);
    } else if (char === " " || char === "\t") endWord();
    else if (char === "\n" || char === ";") endCommand();
    else if (char === "|") {
      endCommand(next !== "|");
      if (next === "|") index++;
    } else if (char === "&") {
      if (next !== "&") return refuse("Running in the background");
      endCommand();
      index++;
    } else if (
      char === ">" &&
      command.slice(wordStart, index) === "2" &&
      command.startsWith(">&1", index) &&
      WORD_ENDS.has(command.charAt(index + 3))
    ) {
      // `2>&1` only joins a command's errors to its output, which the agent reads anyway.
      // zsh reads `2>&1foo` as that and a redirection to `1foo`.
      word = null;
      index += 2;
    } else if (char === ">" || char === "<") return refuse("Redirection");
    else if (char === "$" || char === "`") return refuse("Expansion");
    else if ("(){}".includes(char)) return refuse("A subshell or group");
    else if (char === "#" && word === null) return refuse("A comment");
    // zsh expands `~` and `=` after empty quotes too: `''~/x`, `""=ls`.
    else if (char === "~" && (word === null || word === "" || assigns))
      return refuse("A home path");
    else if (char === "=" && (word === null || word === "")) return refuse("zsh's =command");
    else {
      if (PATTERN.test(char)) pattern = true;
      append(char, true);
    }
  }
  endCommand();
  return { _tag: "ok", commands };
};

/** One simple command's program, arguments and rule's judgment; null for a program that isn't allowed. */
const judge = ({ words, patterns }: SimpleCommand) => {
  const [word = "", ...args] = words;
  const program = programName(word);
  // The rule counts its arguments from 0; the command's words from the program.
  const argPatterns = new Set([...patterns].flatMap((index) => (index > 0 ? [index - 1] : [])));
  const rule = PROGRAMS.get(program);
  return {
    program,
    args,
    argPatterns,
    judged: rule === undefined ? null : rule(args, argPatterns),
  };
};

/** Why a command isn't a plain read-only one, or null when every part of it is. */
const readOnlyProblem = (commands: ReadonlyArray<SimpleCommand>) => {
  if (commands.length === 0) return "The command is empty.";
  for (const command of commands) {
    const { program, judged } = judge(command);
    if (judged === null) return `${program} isn't allowed.`;
    if (judged._tag === "refused") return `${judged.reason}.`;
  }
  return null;
};

/**
 * The arguments of a command that name files it reads, which the agent's path check
 * resolves (docs/internals/architecture.md "Agents"): each program's file operands,
 * every operand of git, which compares files outside its repository given two paths,
 * and every pattern the shell expands, whatever reads it, since the shell lists folders
 * to expand it. `option` when the program could take a match of it as an option.
 */
export const fileArguments = (command: string): ReadonlyArray<PathArgument> => {
  const parsed = parse(command);
  if (parsed._tag === "error") return [];
  return parsed.commands.flatMap((simple) => {
    const { args, argPatterns, judged } = judge(simple);
    const reads = judged?._tag === "reads" ? judged : { files: [], end: args.length };
    return [...new Set([...reads.files, ...argPatterns])]
      .toSorted((left, right) => left - right)
      .map((index) => ({ path: args[index] ?? "", option: index < reads.end }));
  });
};

export const decideBash = (command: string): BashDecision => {
  const parsed = parse(command);
  if (parsed._tag === "error") return { allow: false, reason: parsed.reason };
  const problem = readOnlyProblem(parsed.commands);
  return problem === null
    ? { allow: true }
    : {
        allow: false,
        reason: `${problem} prkit's agent is read-only: use ${[...PROGRAMS.keys()].join(", ")}, or the Read, Grep and Glob tools.`,
      };
};

/** Package managers whose `run <script>` runs one of the repository's own scripts. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Scripts a fix may run by name: tests, lint, type and format checks. Never install, build or deploy. */
const CHECK_SCRIPT =
  /^(test|tests|lint|typecheck|type-check|types|check|tsc|fmt:check|format:check)(:[\w.-]+)?$/;

/** The package.json scripts the fix agent may run, with their commands. */
export const checkScripts = (scripts: Readonly<Record<string, string>>) =>
  Object.entries(scripts)
    .filter(([name]) => CHECK_SCRIPT.test(name))
    .map(([name, command]) => ({ name, command }))
    .toSorted((left, right) => left.name.localeCompare(right.name));

/**
 * The check scripts a fix turn may run by name, or none and why: script bodies come
 * from the PR's author, so they run only on trusted PRs (docs/internals/fix-agent.md).
 */
export type ScriptRuns =
  | { readonly _tag: "allowed"; readonly names: ReadonlyArray<string> }
  | { readonly _tag: "blocked"; readonly reason: string };

/** The script a lone `npm test`, `pnpm run lint`, `yarn typecheck` names, or null. */
const scriptOf = (program: string, args: ReadonlyArray<string>) => {
  const [first = "", second = ""] = args;
  if (first === "test") return { name: "test", rest: args.slice(1) };
  if (first === "run" || first === "run-script") return { name: second, rest: args.slice(2) };
  // pnpm, yarn and bun also run a script named as the first word.
  return program === "npm" || first.startsWith("-") ? null : { name: first, rest: args.slice(1) };
};

/**
 * The fix agent's Bash (docs/internals/fix-agent.md): the same read-only commands,
 * or, when the PR's scripts may run, one of the repository's own check scripts,
 * optionally piped into read-only ones (`npm test 2>&1 | tail -30`). Arguments
 * after the script go to it, but nothing that watches or expands.
 */
export const decideFixBash = (command: string, runs: ScriptRuns): BashDecision => {
  const parsed = parse(command);
  if (parsed._tag === "error") return { allow: false, reason: parsed.reason };
  const [only] = parsed.commands;
  const scripts = runs._tag === "allowed" ? runs.names : [];
  const allowed =
    runs._tag === "blocked"
      ? `prkit runs none of this pull request's scripts: ${runs.reason}.`
      : scripts.length === 0
        ? "This repository has no test, lint or typecheck scripts."
        : `Scripts you can run: ${scripts.map((name) => (name === "test" ? "npm test" : `npm run ${name}`)).join(", ")} (pnpm, yarn and bun work too).`;
  const [program = "", ...args] = only?.words ?? [];
  // A script runs first; anything after it may only read its output through a pipe.
  const rest = parsed.commands.slice(1);
  if (RUNNERS.has(program) && rest.every((command) => command.piped)) {
    if (runs._tag === "blocked")
      return {
        allow: false,
        reason: `${allowed} Check your change by reading it with read-only commands instead.`,
      };
    const script = scriptOf(program, args);
    if (script === null || !scripts.includes(script.name))
      return { allow: false, reason: `Only the repository's check scripts can run. ${allowed}` };
    if (script.rest.some((arg) => /watch/i.test(arg)))
      return { allow: false, reason: "Watch mode never ends. Run the script once." };
    const problem = readOnlyProblem(rest);
    return problem === null || rest.length === 0
      ? { allow: true }
      : { allow: false, reason: `${problem} Pipe a script's output only into read-only commands.` };
  }
  const problem = readOnlyProblem(parsed.commands);
  return problem === null
    ? { allow: true }
    : {
        allow: false,
        reason: `${problem} Use ${[...PROGRAMS.keys()].join(", ")}, the Read, Grep and Glob tools, ${runs._tag === "allowed" ? "Edit and Write for changes, or a check script on its own" : "and Edit and Write for changes"}. ${allowed}`,
      };
};

/** A turn's command rule: read-only commands, and for a fix, the check scripts it may run. */
export const decideTurnBash = (command: string, access: AgentAccess): BashDecision =>
  access._tag === "write" ? decideFixBash(command, access.scripts) : decideBash(command);
