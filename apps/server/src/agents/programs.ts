/**
 * The programs an agent's read-only command may run, each with the flags it may take in
 * every spelling the program accepts (docs/internals/architecture.md "Agents"). Any other
 * flag is refused: a flag the table doesn't name, a prefix of one (git and GNU tools read
 * `--conten` as `--contents`), or a value the flag doesn't take.
 */

/** A flag with a value, attached (`-n5`, `--lines=5`) or, when `separate`, the next word. */
interface ValueFlag {
  readonly value: RegExp;
  readonly separate: boolean;
}

interface Flags {
  /** Flags without a value. A short one shares a word with others (`-in`). */
  readonly switches: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, ValueFlag>;
  /** Takes a count as `-20`, as head, tail and git log do. */
  readonly counts: boolean;
}

/**
 * What a command reads: the indexes of its arguments that name files, and the index of
 * its `--` (the arguments' length without one), after which nothing is an option.
 */
export type Judgment =
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "reads"; readonly files: ReadonlyArray<number>; readonly end: number };

/**
 * One program's rule. `patterns` are the indexes of arguments the shell expands, which
 * can become several words and move every operand after them.
 */
type Program = (args: ReadonlyArray<string>, patterns: ReadonlySet<number>) => Judgment;

const NUMBER = /^\d+$/;
const COUNT = /^[+-]?\d+$/;
const WORD = /^[\w.,:%+-]+$/;
const TEXT = /^[\s\S]*$/;
/** A log format without `%G`, whose placeholders make git run gpg on the commit's signature. */
const FORMAT = /^(?![\s\S]*%G)[\s\S]*$/;

/** Builds a flag table: `switches` as written, `values` as `[spellings, value, separate]`. */
const flags = (
  switches: string,
  values: ReadonlyArray<readonly [string, RegExp, boolean]> = [],
  counts = false,
): Flags => ({
  switches: new Set(switches.split(" ").filter((flag) => flag !== "")),
  values: new Map(
    values.flatMap(([names, value, separate]) =>
      names.split(" ").map((name) => [name, { value, separate }] as const),
    ),
  ),
  counts,
});

const refused = (reason: string): Judgment => ({ _tag: "refused", reason });

/** The operands of `args` read by `table`, and where options end; refused at the first other flag. */
const readFlags = (program: string, table: Flags, args: ReadonlyArray<string>) => {
  const operands: Array<number> = [];
  const given = new Set<string>();
  const valued = (name: string, flag: ValueFlag, value: string) => {
    given.add(name);
    return flag.value.test(value) ? null : `${program} ${name} ${value} isn't allowed`;
  };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (arg === "--") {
      for (let rest = at + 1; rest < args.length; rest++) operands.push(rest);
      return { _tag: "read", operands, given, end: at } as const;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(at);
      continue;
    }
    if (table.counts && NUMBER.test(arg.slice(1))) continue;
    if (arg.startsWith("--")) {
      if (table.switches.has(arg)) {
        given.add(arg);
        continue;
      }
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const flag = table.values.get(name);
      if (flag === undefined || (equals === -1 && (!flag.separate || at + 1 >= args.length)))
        return { _tag: "refused", reason: `${program} ${name} isn't allowed` } as const;
      const problem = valued(
        name,
        flag,
        equals === -1 ? (args[++at] ?? "") : arg.slice(equals + 1),
      );
      if (problem !== null) return { _tag: "refused", reason: problem } as const;
      continue;
    }
    for (let letter = 1; letter < arg.length; letter++) {
      const name = `-${arg.charAt(letter)}`;
      const flag = table.values.get(name);
      const rest = arg.slice(letter + 1);
      if (flag !== undefined && (rest !== "" || !table.switches.has(name))) {
        if (rest === "" && (!flag.separate || at + 1 >= args.length))
          return { _tag: "refused", reason: `${program} ${name} isn't allowed` } as const;
        const problem = valued(name, flag, rest === "" ? (args[++at] ?? "") : rest);
        if (problem !== null) return { _tag: "refused", reason: problem } as const;
        break;
      }
      if (!table.switches.has(name))
        return { _tag: "refused", reason: `${program} ${name} isn't allowed` } as const;
      given.add(name);
    }
  }
  return { _tag: "read", operands, given, end: args.length } as const;
};

/** A program whose every operand is a file it reads. */
const readsOperands =
  (program: string, table: Flags): Program =>
  (args) => {
    const read = readFlags(program, table, args);
    return read._tag === "refused"
      ? refused(read.reason)
      : { _tag: "reads", files: read.operands, end: read.end };
  };

const RG = flags(
  "-i --ignore-case -S --smart-case -s --case-sensitive -w --word-regexp -x --line-regexp " +
    "-v --invert-match -F --fixed-strings -P --pcre2 -U --multiline --multiline-dotall " +
    "-n --line-number -N --no-line-number -H --with-filename -I --no-filename " +
    "-l --files-with-matches --files-without-match -c --count --count-matches -o --only-matching " +
    "-q --quiet --heading --no-heading --column --no-column -b --byte-offset --vimgrep --json " +
    "--stats --trim -0 --null -p --pretty --passthru --hidden -. --no-ignore --no-ignore-vcs " +
    "--no-ignore-dot --no-ignore-parent --no-ignore-global --no-require-git -u --unrestricted " +
    "-a --text --binary --files --type-list --sort-files --no-messages --no-config " +
    "--include-zero --max-columns-preview --crlf --null-data --line-buffered --block-buffered " +
    "--glob-case-insensitive --one-file-system -h --help -V --version",
  [
    ["-e --regexp -g --glob --iglob --type-add -r --replace --colors", TEXT, true],
    ["--context-separator --field-match-separator --field-context-separator", TEXT, true],
    [
      "-t --type -T --type-not --type-clear --sort --sortr --color -E --encoding --engine",
      WORD,
      true,
    ],
    ["-A -B -C --after-context --before-context --context -m --max-count", NUMBER, true],
    ["-M --max-columns -d --max-depth --maxdepth -j --threads", NUMBER, true],
    ["--max-filesize", /^\d+[KMG]?$/, true],
  ],
);

/**
 * rg's first operand is its search pattern, unless a flag gives the pattern or it lists
 * files instead of searching. A pattern the shell expands at or before that operand can
 * become several words and move the search pattern onto a path, so then every operand
 * counts as a path.
 */
const rg: Program = (args, patterns) => {
  const read = readFlags("rg", RG, args);
  if (read._tag === "refused") return refused(read.reason);
  const [first = args.length] = read.operands;
  const searched = ["-e", "--regexp", "--files", "--type-list"].some((flag) =>
    read.given.has(flag),
  );
  const moved = [...patterns].some((index) => index <= first);
  return {
    _tag: "reads",
    files: searched || moved ? read.operands : read.operands.slice(1),
    end: read.end,
  };
};

/** Options every git command that prints a diff takes; none reads or writes another file. */
const DIFF_SWITCHES =
  "-p -u --patch -s --no-patch --raw --patch-with-raw --patch-with-stat --stat --numstat " +
  "--shortstat --compact-summary --summary --name-only --name-status --minimal --patience " +
  "--histogram -w --ignore-all-space -b --ignore-space-change --ignore-space-at-eol " +
  "--ignore-blank-lines --ignore-cr-at-eol -W --function-context --color --no-color -R " +
  "-a --text --no-renames -M -C --find-renames --find-copies --word-diff --color-words " +
  "--no-prefix --full-index --binary --abbrev --check -z --no-ext-diff --no-textconv " +
  "--irreversible-delete -D --exit-code --quiet --color-moved --no-color-moved --dirstat " +
  "--pickaxe-all --pickaxe-regex -U --unified";
const DIFF_VALUES = [
  ["-S -G", TEXT, true],
  ["-U --unified", NUMBER, false],
  ["--stat --dirstat --color --color-moved --word-diff --diff-algorithm", WORD, false],
  ["--diff-filter", /^[ACDMRTUXB*]+$/i, false],
  ["-M -C --find-renames --find-copies", /^\d+%?$/, false],
  ["--abbrev --inter-hunk-context", NUMBER, false],
  ["--src-prefix --dst-prefix", TEXT, false],
] as const;
const LOG_SWITCHES =
  "--oneline --graph --decorate --no-decorate --first-parent --no-merges --merges --reverse " +
  "--abbrev-commit --no-abbrev-commit --follow --left-right --cherry-pick --cherry-mark " +
  "--boundary --date-order --topo-order --author-date-order --full-history --simplify-merges " +
  "--ancestry-path --parents --children --source --all --branches --tags --remotes " +
  "-i --regexp-ignore-case --all-match --invert-grep -E --extended-regexp -F --fixed-strings " +
  "--no-walk --pretty --mailmap --use-mailmap --no-mailmap --relative-date --no-notes";
const LOG_VALUES = [
  ["-n --max-count", NUMBER, true],
  ["--author --committer --grep --since --after --until --before", TEXT, true],
  ["--skip --min-parents --max-parents", NUMBER, false],
  ["--format --pretty", FORMAT, false],
  ["--date", TEXT, false],
  ["--decorate", WORD, false],
] as const;

/**
 * git's read-only subcommands. Every operand, revision or path, is judged as a path:
 * `git diff /dev/null <file>` compares files outside the repository on its own.
 */
const GIT: ReadonlyMap<string, Flags> = new Map([
  ["diff", flags(`${DIFF_SWITCHES} --cached --staged --merge-base`, DIFF_VALUES)],
  ["log", flags(`${DIFF_SWITCHES} ${LOG_SWITCHES}`, [...DIFF_VALUES, ...LOG_VALUES], true)],
  ["show", flags(`${DIFF_SWITCHES} ${LOG_SWITCHES}`, [...DIFF_VALUES, ...LOG_VALUES], true)],
  [
    "blame",
    flags(
      "-b --root --show-stats -l -t -f --show-name -n --show-number -s -e --show-email -w " +
        "-p --porcelain --line-porcelain -c -M -C --color-lines --color-by-age",
      [
        ["-L", TEXT, true],
        ["--date", TEXT, false],
        ["-M -C", NUMBER, false],
        ["--abbrev", NUMBER, false],
      ],
    ),
  ],
  [
    "ls-files",
    flags(
      "-c --cached -d --deleted -m --modified -o --others -s --stage -u --unmerged -z -t " +
        "--full-name --error-unmatch --exclude-standard --directory --no-empty-directory " +
        "--eol --deduplicate --sparse",
      [
        ["-x --exclude", TEXT, true],
        ["--abbrev", NUMBER, false],
        ["--format", TEXT, false],
      ],
    ),
  ],
  [
    "rev-parse",
    flags(
      "--show-toplevel --show-prefix --show-cdup --git-dir --absolute-git-dir --git-common-dir " +
        "--is-inside-work-tree --is-inside-git-dir --is-bare-repository --abbrev-ref --short " +
        "--verify -q --quiet --symbolic --symbolic-full-name",
      [
        ["--short", NUMBER, false],
        ["--abbrev-ref", WORD, false],
      ],
    ),
  ],
  ["merge-base", flags("--all --is-ancestor --fork-point --octopus --independent")],
]);

const git: Program = ([subcommand = "", ...rest], patterns) => {
  const table = GIT.get(subcommand);
  if (table === undefined)
    return refused(`git ${subcommand} isn't allowed. Use one of: ${[...GIT.keys()].join(", ")}`);
  const judged = readsOperands(`git ${subcommand}`, table)(rest, patterns);
  return judged._tag === "refused"
    ? judged
    : {
        _tag: "reads",
        files: judged.files.map((index) => index + 1),
        end: judged.end + 1,
      };
};

/** Only printing a range of lines, Codex's usual way to read part of a file. */
const sed: Program = (args) => {
  const [flag, script = "", ...files] = args;
  return flag === "-n" &&
    /^(\d+|\$)(,(\d+|\$))?p$/.test(script) &&
    files.length > 0 &&
    files.every((file) => !file.startsWith("-"))
    ? { _tag: "reads", files: files.map((_, index) => index + 2), end: args.length }
    : refused("sed can only print lines, as in sed -n '1,80p' <file>");
};

export const PROGRAMS: ReadonlyMap<string, Program> = new Map<string, Program>([
  ["git", git],
  ["rg", rg],
  [
    "ls",
    readsOperands(
      "ls",
      flags(
        "-1 -a -A -b -B -c -C -d -e -f -F -g -G -h -i -k -l -m -n -o -p -q -r -R -s -S -t -T -u " +
          "-U -v -w -x -@ -O -% --all --almost-all --classify --directory --human-readable " +
          "--inode --reverse --recursive --size --group-directories-first --color",
        [["--sort --time --color --format", WORD, false]],
      ),
    ),
  ],
  [
    "wc",
    readsOperands("wc", flags("-c -l -m -w -L --bytes --chars --lines --words --max-line-length")),
  ],
  [
    "head",
    readsOperands(
      "head",
      flags("-q -v --quiet --silent --verbose", [["-n -c --lines --bytes", COUNT, true]], true),
    ),
  ],
  [
    "tail",
    readsOperands(
      "tail",
      flags("-q -v -r --quiet --silent --verbose", [["-n -c --lines --bytes", COUNT, true]], true),
    ),
  ],
  [
    "cat",
    readsOperands(
      "cat",
      flags(
        "-b -e -n -s -t -u -v -A -E -T --number --number-nonblank --squeeze-blank --show-all " +
          "--show-ends --show-tabs --show-nonprinting",
      ),
    ),
  ],
  // echo reads nothing; the shell still lists the folders of any pattern it is given.
  ["echo", (args) => ({ _tag: "reads", files: [], end: args.length })],
  [
    "pwd",
    (args) =>
      args.length === 0 ? { _tag: "reads", files: [], end: 0 } : refused("pwd takes no arguments"),
  ],
  ["sed", sed],
]);

/** The value flags of rg, for reading which word is its search pattern. */
export const RG_VALUE_FLAGS: ReadonlySet<string> = new Set(
  [...RG.values].flatMap(([name, flag]) => (flag.separate ? [name] : [])),
);
