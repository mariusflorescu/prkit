// @effect-diagnostics-next-line nodeBuiltinImport:off -- Read the public documentation directly in this static contract test.
import * as NodeFs from "node:fs";

import { expect, it } from "vite-plus/test";
import { commandParameters, mappings } from "./commands.ts";

type Word = { value: string; quoted: boolean; line: number };
type Token = Word | { end: true };
type Snippet = { source: string; line: number; allowGroup: boolean };

const rootFlags = new Map([
  ["help", true],
  ["version", true],
  ["completions", false],
  ["json", true],
]);
const isFlag = (word: Word) => !word.quoted && word.value.startsWith("-");

const shellTokens = (source: string, firstLine: number) => {
  const tokens: Token[] = [];
  let value = "";
  let quoted = false;
  let quote = "";
  let line = firstLine;
  let wordLine = firstLine;
  const flush = () => {
    if (value.length > 0 || quoted) {
      const text = quoted ? value : value.replace(/^\[+|\]+$/g, "");
      if (text.length > 0 || quoted) tokens.push({ value: text, quoted, line: wordLine });
      value = "";
      quoted = false;
    }
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === undefined) break;
    const next = source[index + 1];
    if (character === "\\" && quote !== "'") {
      if (next === "\n") line++;
      else if (next !== undefined) {
        if (value.length === 0) wordLine = line;
        value += next;
      }
      index++;
    } else if (quote.length > 0) {
      if (character === quote) quote = "";
      else {
        value += character;
        if (character === "\n") line++;
      }
    } else if (character === "'" || character === '"') {
      if (value.length === 0) wordLine = line;
      quote = character;
      quoted = true;
    } else if (character === "#" && value.length === 0) {
      while (index < source.length && source[index] !== "\n") index++;
      flush();
      tokens.push({ end: true });
      line++;
    } else if (
      character === "\n" ||
      character === ";" ||
      ((character === "|" || character === "&") && value.length === 0)
    ) {
      flush();
      tokens.push({ end: true });
      if (character === "\n") line++;
      if (next === character) index++;
    } else if (/\s/.test(character)) flush();
    else {
      if (value.length === 0) wordLine = line;
      value += character;
    }
  }
  flush();
  return tokens;
};

const snippets = (markdown: string) => {
  const found: Snippet[] = [];
  let fence = "";
  let code: string[] = [];
  let firstLine = 1;
  for (const [index, line] of markdown.split("\n").entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined && fence.length === 0) {
      fence = marker;
      code = [];
      firstLine = index + 2;
    } else if (fence.length > 0) {
      if (marker?.startsWith(fence) === true) {
        found.push({ source: code.join("\n"), line: firstLine, allowGroup: false });
        fence = "";
      } else code.push(line);
    } else {
      for (const match of line.matchAll(/(`+)(.*?)\1/g)) {
        const source = match[2];
        if (source !== undefined) found.push({ source, line: index + 1, allowGroup: true });
      }
    }
  }
  if (fence.length > 0) found.push({ source: code.join("\n"), line: firstLine, allowGroup: false });
  return found;
};

const flagsFor = (entries: typeof mappings) => {
  const flags = new Map(rootFlags);
  for (const [name, mapping] of entries)
    for (const field of commandParameters(name, mapping))
      flags.set(field.name, field.ast._tag === "Boolean");
  return flags;
};

const checkCommand = (file: string, words: Word[], allowGroup: boolean) => {
  const errors: string[] = [];
  const path: string[] = [];
  const usedFlags: Word[] = [];
  let target = false;
  let generic = false;
  let invalidPath = false;
  let candidates = mappings;
  const problem = (word: Word, kind: string) =>
    errors.push(`${file}:${word.line}: ${kind} ${word.value}`);
  const handler = () => candidates.find(([, mapping]) => mapping.path.length === path.length);
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === undefined) break;
    if (isFlag(word)) {
      usedFlags.push(word);
      const name = word.value.replace(/^--?/, "").split("=")[0] ?? "";
      const flags = flagsFor(candidates);
      const boolean = flags.get(name.startsWith("no-") ? name.slice(3) : name);
      const next = words[index + 1];
      if (!word.value.includes("=") && boolean !== true && next !== undefined && !isFlag(next))
        index++;
      continue;
    }
    if (invalidPath) continue;
    const children = candidates.filter(([, mapping]) => mapping.path[path.length] === word.value);
    if (!target && children.length > 0) {
      path.push(word.value);
      candidates = children;
    } else if (path.length === 0 && word.value === "<command>") generic = true;
    else if (generic) continue;
    else if (!target && handler()?.[1].target !== undefined) target = true;
    else {
      problem(word, "unknown command");
      invalidPath = true;
    }
  }
  const entry = handler();
  const flags = flagsFor(entry === undefined ? [] : [entry]);
  for (const word of usedFlags) {
    const name = word.value.replace(/^--?/, "").split("=")[0] ?? "";
    const negated = name.startsWith("no-");
    const base = negated ? name.slice(3) : name;
    if (
      !word.value.startsWith("--") ||
      !flags.has(base) ||
      (negated && (flags.get(base) !== true || (rootFlags.has(base) && base !== "json")))
    )
      problem(word, "unknown flag");
  }
  if (
    !invalidPath &&
    path.length > 0 &&
    entry === undefined &&
    !allowGroup &&
    !usedFlags.some((word) => word.value === "--help")
  ) {
    const first = words[0];
    if (first !== undefined) problem({ ...first, value: path.join(" ") }, "incomplete command");
  }
  return errors;
};

const documentationProblems = (file: string, markdown: string) => {
  const errors: string[] = [];
  let commands = 0;
  for (const snippet of snippets(markdown)) {
    let words: Word[] = [];
    const check = () => {
      for (const [index, word] of words.entries()) {
        if (word.value !== "prkit" || word.quoted) continue;
        commands++;
        errors.push(...checkCommand(file, words.slice(index + 1), snippet.allowGroup));
        break;
      }
      words = [];
    };
    for (const token of shellTokens(snippet.source, snippet.line)) {
      if ("end" in token) check();
      else words.push(token);
    }
    check();
  }
  return { commands, errors };
};

const skillMarkdown = (folder: URL): URL[] =>
  NodeFs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), folder);
    return entry.isDirectory() ? skillMarkdown(file) : entry.name.endsWith(".md") ? [file] : [];
  });

it("keeps every public skill and CLI documentation command aligned with the real command map", () => {
  const root = new URL("../../../../", import.meta.url);
  const files = [
    ...skillMarkdown(new URL("skills/prkit-cli/", root)),
    new URL("docs/features/cli.md", root),
  ];
  const results = files.map((file) =>
    documentationProblems(
      file.pathname.slice(root.pathname.length),
      NodeFs.readFileSync(file, "utf8"),
    ),
  );
  expect(results.reduce((sum, result) => sum + result.commands, 0)).toBeGreaterThan(0);
  expect(results.flatMap((result) => result.errors)).toEqual([]);
});

it("reports misspelled paths, unknown flags and invalid boolean negation with file and line", () => {
  expect(
    documentationProblems(
      "example.md",
      [
        "```sh",
        "prkit pr fils <pr> --json",
        "prkit inbox --reson authored",
        "prkit wait <pr> --no-timeout",
        "prkit status --reason authored",
        "prkit status -json",
        "```",
      ].join("\n"),
    ).errors,
  ).toEqual([
    "example.md:2: unknown command fils",
    "example.md:3: unknown flag --reson",
    "example.md:4: unknown flag --no-timeout",
    "example.md:5: unknown flag --reason",
    "example.md:6: unknown flag -json",
  ]);
});

it("reads inline commands, continuations, optional flags and quoted shell values without inventing flags", () => {
  const markdown = [
    "Use `prkit status --json` or `prkit <command> --help`.",
    "```sh",
    "prkit comments add <pr> --body '`prkit typo --not-a-flag`' \\",
    '  --path "a file.ts" --line 42 # prkit nope --bad',
    "prkit guide generate <pr> [--agent <instance>] [--model <model>] --option effort=high",
    "prkit pr open <pr> --no-focus",
    'prkit inbox filters save --search "" --account null --repo null --json',
    "prkit guide settings save <pr> --expected-version 0 --edit '{}'",
    "```",
    "Not a command: `$PRKIT_HOME/bin/prkit` or `echo 'prkit nope --bad'`.",
  ].join("\n");
  expect(documentationProblems("example.md", markdown)).toEqual({ commands: 7, errors: [] });
});
