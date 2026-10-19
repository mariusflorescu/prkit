import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "release-version.ts");
const resolveScript = NodePath.join(
  import.meta.dirname,
  "..",
  ".github",
  "scripts",
  "resolve-release.sh",
);
const repos: Array<string> = [];

const ManifestNotes = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ version: Schema.String, note: Schema.String })),
);

afterEach(() => {
  for (const dir of repos.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository; each commit is a second after the last so the tag order is stable. */
const repository = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "release-version-"));
  repos.push(dir);
  let clock = 1_790_000_000;
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Octo Cat",
        GIT_AUTHOR_EMAIL: "octocat@example.com",
        GIT_COMMITTER_NAME: "Octo Cat",
        GIT_COMMITTER_EMAIL: "octocat@example.com",
        GIT_AUTHOR_DATE: `${clock} +0000`,
        GIT_COMMITTER_DATE: `${clock} +0000`,
      },
    });
  git("init", "--quiet", "--initial-branch", "main");
  const repo = {
    commit: (message: string) => {
      clock += 1;
      git("commit", "--quiet", "--allow-empty", "--message", message);
      return repo;
    },
    tag: (name: string) => {
      git("tag", name);
      return repo;
    },
    run: (...args: ReadonlyArray<string>) => {
      const result = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });
      return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
    },
    /** The release workflow's decision for a run on main HEAD. */
    resolve: (date: string, runNumber: number, channel = "nightly") => {
      const file = (name: string) => NodePath.join(dir, ".git", `resolve-${runNumber}-${name}`);
      const result = NodeChildProcess.spawnSync("bash", [resolveScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          CHANNEL: channel,
          DRY_RUN: "false",
          COMMIT: git("rev-parse", "HEAD").trim(),
          REF: "refs/heads/main",
          RUN_DATE: date,
          RUN_NUMBER: String(runNumber),
          REPOSITORY: "acme/widgets",
          NOTES_FILE: file("notes"),
          MANIFEST_NOTES_FILE: file("manifest-notes"),
          GITHUB_OUTPUT: file("output"),
          GITHUB_STEP_SUMMARY: file("summary"),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const output = Object.fromEntries(
        NodeFS.readFileSync(file("output"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      const notes = NodeFS.existsSync(file("notes"))
        ? NodeFS.readFileSync(file("notes"), "utf8")
        : "";
      const manifestNotes = NodeFS.existsSync(file("manifest-notes"))
        ? Schema.decodeUnknownSync(ManifestNotes)(
            NodeFS.readFileSync(file("manifest-notes"), "utf8"),
          )
        : [];
      return { output, notes, manifestNotes };
    },
  };
  return repo.commit("Initial commit");
};

const next = (repo: ReturnType<typeof repository>) => {
  const result = repo.run("next");
  expect(result.status).toBe(0);
  return result.stdout;
};

describe("release-version next", () => {
  it("has nothing to release before the first change", () => {
    expect(next(repository())).toBe("");
  });

  it("has nothing to release when only other types landed", () => {
    const repo = repository()
      .commit("chore: bump deps (#1)")
      .commit("docs: explain the inbox (#2)")
      .commit("test(inbox): cover grouping (#3)")
      .commit("ci: cache pnpm (#4)")
      .commit("refactor: split the store (#5)");
    expect(next(repo)).toBe("");
    expect(next(repo.tag("v0.1.0").commit("chore: tidy (#6)"))).toBe("");
  });

  it("starts at 0.1.0", () => {
    expect(next(repository().commit("fix: crash on start (#1)"))).toBe("0.1.0");
    expect(next(repository().commit("feat: an inbox (#1)").commit("feat: tabs (#2)"))).toBe(
      "0.1.0",
    );
  });

  it.each([
    [["fix: crash (#2)"], "0.3.5"],
    [["perf: faster diff (#2)"], "0.3.5"],
    [["fix: crash (#2)", "perf: faster diff (#3)"], "0.3.5"],
    [["feat(inbox): group PRs (#2)"], "0.4.0"],
    [["fix: crash (#2)", "feat: tabs (#3)", "chore: tidy (#4)"], "0.4.0"],
    [["fix!: drop the old config (#2)"], "0.4.0"],
    [["refactor!: rename the settings file (#2)"], "0.4.0"],
    [["fix: move the settings file (#2)\n\nBREAKING CHANGE: the old path is gone."], "0.4.0"],
  ])("bumps 0.3.4 with %j to %s", (messages, expected) => {
    const repo = repository().commit("feat: an inbox (#1)").tag("v0.3.4");
    for (const message of messages) repo.commit(message);
    expect(next(repo)).toBe(expected);
  });

  it("ignores nightly tags", () => {
    const repo = repository()
      .commit("feat: an inbox (#1)")
      .tag("v0.1.0")
      .commit("fix: crash (#2)")
      .tag("v0.1.1-nightly.20261013.4")
      .commit("chore: tidy (#3)")
      .tag("v0.1.1-nightly.20261014.5");
    expect(next(repo)).toBe("0.1.1");
    expect(next(repo.commit("feat: tabs (#4)"))).toBe("0.2.0");
  });
});

describe("release-version nightly", () => {
  it("appends the date and run number to the next version", () => {
    const repo = repository().commit("feat: an inbox (#1)").tag("v0.1.0").commit("fix: crash (#2)");
    expect(repo.run("nightly", "--date", "20261014", "--run", "7")).toMatchObject({
      status: 0,
      stdout: "0.1.1-nightly.20261014.7",
    });
  });

  it("prints nothing when there is nothing to release", () => {
    const repo = repository().commit("feat: an inbox (#1)").tag("v0.1.0").commit("docs: x (#2)");
    expect(repo.run("nightly", "--date", "20261014", "--run", "7")).toMatchObject({
      status: 0,
      stdout: "",
    });
  });

  it.each([
    ["2026-10-14", "7"],
    ["20261014", "0"],
    ["20261014", "seven"],
  ])("refuses --date %s --run %s", (date, run) => {
    expect(
      repository().commit("feat: x (#1)").run("nightly", "--date", date, "--run", run),
    ).toMatchObject({ status: 1, stdout: "" });
  });
});

describe("release-version notes", () => {
  const history = () =>
    repository()
      .commit("feat: an inbox (#1)")
      .tag("v0.1.0")
      .commit("perf(diff): render large files lazily (#2)")
      .commit("chore: bump deps (#3)")
      .commit("fix(inbox): keep the selection after a refresh (#4)\n\nThe body stays out.")
      .commit("feat(tabs): reopen closed PRs (#5)")
      .commit("docs: describe tabs (#6)")
      .commit("refactor!: rename the store (#7)")
      .commit("fix: a fix without a pull request");

  it("groups user-facing changes and links each PR", () => {
    const notes = history().run(
      "notes",
      "--version",
      "0.2.0",
      "--from",
      "v0.1.0",
      "--repository",
      "acme/widgets",
    );
    expect(notes.status).toBe(0);
    expect(notes.stdout).toBe(
      [
        "### Features",
        "",
        "- Reopen closed PRs ([#5](https://github.com/acme/widgets/pull/5))",
        "",
        "### Fixes",
        "",
        "- Keep the selection after a refresh ([#4](https://github.com/acme/widgets/pull/4))",
        "- A fix without a pull request",
        "",
        "### Performance",
        "",
        "- Render large files lazily ([#2](https://github.com/acme/widgets/pull/2))",
      ].join("\n"),
    );
    expect(notes.stdout).not.toMatch(/octo|example\.com|body stays/i);
  });

  it("covers the whole range across nightly and stable tags, and starts at the first commit without --from", () => {
    const repo = history().tag("v0.2.0-nightly.20261014.1");
    const notes = repo.run("notes", "--version", "0.2.0", "--repository", "acme/widgets");
    expect(notes.stdout).toContain("- An inbox ([#1]");
    expect(notes.stdout).toContain("- Reopen closed PRs ([#5]");
    expect(notes.stdout.match(/### Features/g)).toHaveLength(1);
  });

  it("says so when nothing user-facing changed", () => {
    const repo = history().commit("chore: tidy (#8)");
    expect(
      repo.run("notes", "--version", "0.2.1", "--from", "HEAD~1", "--repository", "acme/widgets"),
    ).toMatchObject({ status: 0, stdout: "No user-facing changes in this release." });
  });

  it("needs the repository for the links", () => {
    expect(history().run("notes", "--version", "0.2.0")).toMatchObject({ status: 1 });
  });
});

describe("resolve-release nightly", () => {
  it("publishes nothing on a run with no commit since the latest nightly", () => {
    const repo = repository().commit("feat: an inbox (#1)").tag("v0.1.0-nightly.20261019.11");
    expect(repo.resolve("20261019", 12).output).toEqual({ release: "false" });
    expect(repo.commit("fix: crash on start (#2)").resolve("20261019", 13).output).toMatchObject({
      release: "true",
      tag: "v0.1.0-nightly.20261019.13",
    });
  });

  it("starts the notes of a day's second nightly where the first ended", () => {
    const repo = repository()
      .commit("feat: an inbox (#1)")
      .tag("v0.1.0-nightly.20261019.9")
      .commit("fix: crash on start (#2)")
      .tag("v0.1.0-nightly.20261019.10")
      .commit("fix: hang on quit (#3)");
    const run = repo.resolve("20261019", 11);
    expect(run.output).toMatchObject({ release: "true", version: "0.1.0-nightly.20261019.11" });
    expect(run.notes).toContain("Hang on quit");
    expect(run.notes).not.toContain("Crash on start");
  });
});

describe("resolve-release manifest notes", () => {
  const versions = (notes: ReadonlyArray<{ readonly version: string }>) =>
    notes.map((entry) => entry.version);

  it("gives a stable every stable before it, however many nightlies came after the last one", () => {
    const repo = repository()
      .commit("feat: an inbox (#1)")
      .tag("v0.1.0-nightly.20261001.1")
      .tag("v0.1.0")
      .commit("fix: crash on start (#2)")
      .tag("v0.1.1-nightly.20261002.2")
      .tag("v0.1.1");
    for (let run = 3; run <= 14; run++)
      repo.commit(`fix: hang number ${run} (#${run})`).tag(`v0.1.2-nightly.20261003.${run}`);
    const { output, manifestNotes } = repo.resolve("20261003", 15, "stable");
    expect(output).toMatchObject({ release: "true", version: "0.1.2" });
    expect(versions(manifestNotes)).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
    const [newest, previous, first] = manifestNotes.map((entry) => entry.note);
    expect(newest).toContain("Hang number 3");
    expect(newest).toContain("Hang number 14");
    expect(previous).toContain("Crash on start");
    expect(previous).not.toMatch(/An inbox|Hang number/);
    expect(first).toContain("An inbox");
    expect(first).not.toContain("Crash on start");
  }, 60_000);

  it("gives a nightly the nightlies before it, each with its own changes, ten in all", () => {
    const repo = repository().commit("feat: an inbox (#1)").tag("v0.1.0");
    for (let run = 1; run <= 3; run++)
      repo.commit(`fix: hang number ${run} (#${run})`).tag(`v0.1.1-nightly.20261009.${run}`);
    const short = repo.commit("fix: hang number 4 (#4)").resolve("20261009", 4).manifestNotes;
    expect(versions(short)).toEqual([
      "0.1.1-nightly.20261009.4",
      "0.1.1-nightly.20261009.3",
      "0.1.1-nightly.20261009.2",
    ]);
    expect(short[1]?.note).toContain("Hang number 3");
    expect(short[1]?.note).not.toContain("Hang number 2");

    repo.tag("v0.1.1-nightly.20261009.4");
    for (let run = 5; run <= 12; run++)
      repo.commit(`fix: hang number ${run} (#${run})`).tag(`v0.1.1-nightly.20261010.${run}`);
    const full = repo.commit("fix: hang number 13 (#13)").resolve("20261010", 13).manifestNotes;
    expect(versions(full)).toEqual([
      "0.1.1-nightly.20261010.13",
      ...[12, 11, 10, 9, 8, 7, 6, 5].map((run) => `0.1.1-nightly.20261010.${run}`),
      "0.1.1-nightly.20261009.4",
    ]);
    expect(full[0]?.note).toContain("Hang number 13");
    expect(full[0]?.note).not.toContain("Hang number 12");
  }, 60_000);
});
