import { describe, expect, it } from "vite-plus/test";

import { checkScripts, decideBash, decideFixBash, fileArguments } from "./bashPolicy.ts";

// The agent's only defense against writing to the checkout or running arbitrary
// programs. Every row is a command an agent has tried or could try.
describe("decideBash", () => {
  it.each([
    "git diff 0fb0d77 HEAD -- src/store.js",
    "git log --oneline -5",
    "git show b06c15d:src/store.js | head -40",
    "rg -n 'validateUrl|shorten' src",
    'rg "a|b" src && wc -l src/store.js',
    "cat src/validate.js; ls test",
    "tail -n 20 src/server.js",
    "git diff HEAD~1 -- src/store.js",
    "sed -n '1,240p' src/store.js",
    "sed -n '40,$p' src/store.js src/server.js",
    "/bin/cat src/validate.js",
    "/usr/bin/sed -n 5p src/store.js",
    "pwd",
    "rg -iA3 -e foo -g '*.ts' --type ts src",
    "rg --files src",
    "rg -n --color=never 'a\\.b' src",
    "git log -n 5 --format=%H --author alice",
    "git log -5 --oneline -- src",
    "git blame -L 10,20 -w src/a.js",
    "git diff --stat=100 -M50% --cached main...HEAD",
    "git show --name-only HEAD",
    "git rev-parse --abbrev-ref HEAD",
    "head -20 src/a.js",
    "tail -n +5 src/a.js",
    "ls -la src",
    "cat -n src/a.js",
    "wc -l src/a.js",
    'cat "src/a b.js"',
    "git diff HEAD 2>&1 | head -40",
    "git diff HEAD 2>&1;git log -1 2>&1&&pwd",
    "git log --format='%h %an %s' --pretty=oneline",
  ])("allows the read-only command %s", (command) => {
    expect(decideBash(command)).toEqual({ allow: true });
  });

  it.each([
    ["git commit -am wip", "git commit isn't allowed"],
    ["git -c core.pager=sh log", "git -c isn't allowed"],
    ["git log --output=notes.txt", "git log --output isn't allowed"],
    ["echo hi > x.txt", "Redirection isn't allowed"],
    ["cat <(git diff)", "Redirection isn't allowed"],
    ["git diff $(git merge-base HEAD main)", "Expansion isn't allowed"],
    ['cat "$HOME/.ssh/id_rsa"', "Expansion isn't allowed"],
    ["rg --pre ./run.sh foo", "rg --pre isn't allowed"],
    ["rg -iz foo", "rg -z isn't allowed"],
    ["tail -nf 5 log", "tail -n f isn't allowed"],
    ["ls && rm -rf src", "rm isn't allowed"],
    ["sleep 100 &", "Running in the background isn't allowed"],
    ["FOO=1 git log", "FOO=1 isn't allowed"],
    ["(cd src && ls)", "A subshell or group isn't allowed"],
    ["cat ~/.ssh/id_ed25519", "A home path isn't allowed"],
    ["cat =ls", "zsh's =command isn't allowed"],
    ['cat ""=ls', "zsh's =command isn't allowed"],
    ["echo ''~/*", "A home path isn't allowed"],
    ["git diff --no-index /etc/hosts src/a.js", "git diff --no-index isn't allowed"],
    ["git blame --contents /etc/hosts src/a.js", "git blame --contents isn't allowed"],
    ["rg -L secret .", "rg -L isn't allowed"],
    ["rg --follow secret .", "rg --follow isn't allowed"],
    ["rg -f /etc/hosts src", "rg -f isn't allowed"],
    ["wc --files0-from=list.txt", "wc --files0-from isn't allowed"],
    ["sed -i '' s/a/b/ src/a.js", "sed can only print lines"],
    ["sed -n '1w out.txt' src/a.js", "sed can only print lines"],
    ["sed -n -e 1p src/a.js", "sed can only print lines"],
    ["sed -n 1p", "sed can only print lines"],
    ["pwd -P", "pwd takes no arguments"],
    ["/bin/rm -rf src", "rm isn't allowed"],
    ["/opt/homebrew/bin/cat src/a.js", "/opt/homebrew/bin/cat isn't allowed"],
    // The shell joins a line ending in `\` to the next: `--pre=sh`, `../*`.
    ["rg --pr\\\ne=sh TODO .", "A line continuation isn't allowed"],
    ["cat .\\\n./*", "A line continuation isn't allowed"],
    ['cat ".\\\n./x"', "A line continuation isn't allowed"],
    ["cat a.txt\\", "A line continuation isn't allowed"],
    ["cat a.txt\r", "A NUL or carriage return isn't allowed"],
    ["cat a\0b", "A NUL or carriage return isn't allowed"],
    // bash expands `~` after an unquoted `=` or `:`.
    ["cat a=~/x", "A home path isn't allowed"],
    ["cat a:~/x", "A home path isn't allowed"],
    ['cat "2">&1', "Redirection isn't allowed"],
    // zsh reads `2>&1foo` as `2>&1` and a redirection to `1foo`.
    ["cat a.txt nonexist 2>&1foo", "Redirection isn't allowed"],
    ["cat a.txt 2>&1>out.txt", "Redirection isn't allowed"],
    // `%G` placeholders make git run gpg on the commit's signature.
    ["git log --format=%G?", "git log --format %G? isn't allowed"],
    ["git show --pretty='format:%h %GS'", "git show --pretty format:%h %GS isn't allowed"],
    ["git diff /dev/null --no-ind /etc/hosts", "git diff --no-ind isn't allowed"],
    ["git blame -S /etc/hosts src/a.js", "git blame -S isn't allowed"],
    [
      "git blame --ignore-revs-file=/etc/hosts src/a.js",
      "git blame --ignore-revs-file isn't allowed",
    ],
    ["git blame --conten=/etc/hosts src/a.js", "git blame --conten isn't allowed"],
    ["git log --outp=notes.txt", "git log --outp isn't allowed"],
    ["git diff --ext-diff", "git diff --ext-diff isn't allowed"],
    ["git log --show-signature", "git log --show-signature isn't allowed"],
    ["git log -L1,5:src/a.js", "git log -L isn't allowed"],
    ["git ls-files --exclude-from=/etc/hosts", "git ls-files --exclude-from isn't allowed"],
    ["git diff -O/etc/hosts", "git diff -O isn't allowed"],
    ["git log --format %H", "git log --format isn't allowed"],
    ["git status", "git status isn't allowed"],
    ["rg --hostname-bin=./x --hyperlink-format=default TODO .", "rg --hostname-bin isn't allowed"],
    ["rg --pre-glob '*' --search-zip x", "rg --pre-glob isn't allowed"],
    ["rg --ignore-file /etc/hosts x", "rg --ignore-file isn't allowed"],
    ["rg -A x foo", "rg -A x isn't allowed"],
    ["wc --files0=list.txt", "wc --files0 isn't allowed"],
    ["tail -f log", "tail -f isn't allowed"],
    ["tail --fol log", "tail --fol isn't allowed"],
    ["head -n ../x a", "head -n ../x isn't allowed"],
    ["ls -RL .", "ls -L isn't allowed"],
  ])("refuses %s", (command, reason) => {
    const decision = decideBash(command);
    expect(decision.allow).toBe(false);
    expect(decision.allow ? "" : decision.reason).toContain(reason);
  });
});

// The fix agent may also run the repository's own check scripts, and nothing else new,
// and only on a pull request whose scripts may run.
describe("decideFixBash with scripts allowed", () => {
  const runs = { _tag: "allowed", names: ["lint", "test", "typecheck"] } as const;

  it.each([
    "npm test",
    "npm run lint",
    "pnpm run typecheck",
    "pnpm test -- src/limits.test.js",
    "yarn lint",
    "bun run test",
    "git diff HEAD -- src/limits.js",
    "rg -n checkUrl src",
    "npm test 2>&1 | tail -30",
    "cat src/config.js; echo ---; git diff HEAD -- src/config.js",
  ])("allows %s", (command) => {
    expect(decideFixBash(command, runs)).toEqual({ allow: true });
  });

  it.each([
    ["npm install", "Only the repository's check scripts can run"],
    ["npm run build", "Only the repository's check scripts can run"],
    ["npm run deploy", "Only the repository's check scripts can run"],
    ["pnpm exec vitest", "Only the repository's check scripts can run"],
    ["npm --prefix /tmp run test", "Only the repository's check scripts can run"],
    ["npm test -- --watch", "Watch mode never ends"],
    ["npm test && git push origin HEAD", "a check script on its own"],
    ["npx eslint .", "npx isn't allowed"],
    ["CI=1 npm test", "CI=1 isn't allowed"],
    ["git commit -am fix", "git commit isn't allowed"],
    ["node --test", "node isn't allowed"],
    ["npm test > out.txt", "Redirection isn't allowed"],
    ["npm test 2>&1 > out.txt", "Redirection isn't allowed"],
    ["npm test | sh", "sh isn't allowed"],
    ["npm test; rm -rf src", "a check script on its own"],
  ])("refuses %s", (command, reason) => {
    const decision = decideFixBash(command, runs);
    expect(decision.allow).toBe(false);
    expect(decision.allow ? "" : decision.reason).toContain(reason);
  });
});

describe("decideFixBash with scripts blocked", () => {
  const runs = { _tag: "blocked", reason: "it comes from a fork, someone/prkit-fixtures" } as const;

  it.each([
    "git diff HEAD -- src/limits.js",
    "rg -n checkUrl src",
    "cat src/config.js; echo ---; git diff HEAD -- src/config.js",
  ])("allows the read-only command %s", (command) => {
    expect(decideFixBash(command, runs)).toEqual({ allow: true });
  });

  it.each([
    "npm test",
    "pnpm run lint",
    "yarn typecheck",
    "bun run test",
    "npm test 2>&1 | tail -30",
  ])("refuses the check script %s and says why", (command) => {
    expect(decideFixBash(command, runs)).toEqual({
      allow: false,
      reason:
        "prkit runs none of this pull request's scripts: it comes from a fork, someone/prkit-fixtures. Check your change by reading it with read-only commands instead.",
    });
  });

  it("refuses anything else without offering a script", () => {
    expect(decideFixBash("node test/limits.test.js", runs)).toEqual({
      allow: false,
      reason:
        "node isn't allowed. Use git, rg, ls, wc, head, tail, cat, echo, pwd, sed, the Read, Grep and Glob tools, and Edit and Write for changes. prkit runs none of this pull request's scripts: it comes from a fork, someone/prkit-fixtures.",
    });
  });
});

// The words the agent's path check resolves, so a link or an absolute path in them
// can't read a file outside the checkout. A word after `--` is shown after it: a
// pattern there can't expand into an option.
describe("fileArguments", () => {
  it.each([
    ["cat notes.md src/a.js", ["notes.md", "src/a.js"]],
    ["head -n 20 linked/inside.txt | tail -5", ["linked/inside.txt"]],
    ["ls -la . linked; wc -l -- -odd.txt", [".", "linked", "-- -odd.txt"]],
    ["rg -n '/shorten' src notes.md", ["src", "notes.md"]],
    ["rg -n -g '*.js' -e checkUrl -e '/api' /etc", ["/etc"]],
    ["rg -ie secret linked", ["linked"]],
    ["rg --files /etc", ["/etc"]],
    ["rg '../utils' src/*.ts", ["src/*.ts"]],
    ["rg *.ts foo", ["*.ts", "foo"]],
    ["rg -g *.md foo /etc/hosts", ["*.md", "foo", "/etc/hosts"]],
    ["rg -- -foo src", ["-- src"]],
    ["git diff HEAD -- notes.md && echo /etc/hosts", ["HEAD", "-- notes.md"]],
    ["git diff /dev/null /etc/hosts", ["/dev/null", "/etc/hosts"]],
    ["git show HEAD~1:src/a.js 'HEAD~1'", ["HEAD~1:src/a.js", "HEAD~1"]],
    ["npm test -- /etc/hosts", []],
    ["npm test -- src/* | cat /etc/hosts", ["src/*", "/etc/hosts"]],
    ["sed -n '1,80p' notes.md src/a.js", ["notes.md", "src/a.js"]],
    ["/bin/cat /etc/hosts", ["/etc/hosts"]],
    ["echo * && git log -- src/*.js", ["*", "-- src/*.js"]],
    ["rg -g '*.md' -e '.*' src", ["src"]],
    ["cat -- *.txt", ["-- *.txt"]],
  ])("finds the files %s reads", (command, files) => {
    expect(
      fileArguments(command).map(({ path, option }) => (option ? path : `-- ${path}`)),
    ).toEqual(files);
  });
});

describe("checkScripts", () => {
  it("keeps only tests, lint and type checks, with their commands", () => {
    expect(
      checkScripts({
        build: "vite build",
        test: "node --test",
        "test:e2e": "playwright test",
        lint: "eslint .",
        postinstall: "node setup.js",
        typecheck: "tsc --noEmit",
      }),
    ).toEqual([
      { name: "lint", command: "eslint ." },
      { name: "test", command: "node --test" },
      { name: "test:e2e", command: "playwright test" },
      { name: "typecheck", command: "tsc --noEmit" },
    ]);
  });
});
