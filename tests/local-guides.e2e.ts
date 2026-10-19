import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  GenerateLocalGuideResult,
  LocalGuideResult,
  LocalListResult,
  LocalWaitResult,
} from "../apps/server/src/outside/schemas.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { AGENT_RUNS, AGENT_SKIP, GUIDE_WAIT, readRows } from "./fixturePr.ts";
import { setUpRealClaude } from "./realClaude.ts";
import { cliIn, outsideAccess, scratchRoot, switchOn } from "./localGuideSession.ts";
import { localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const decodeRead = Schema.decodeSync(Schema.fromJsonString(LocalGuideResult));
const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));
const decodeList = Schema.decodeSync(Schema.fromJsonString(LocalListResult));
const AttemptRows = Schema.Array(
  Schema.Struct({
    capture: Schema.fromJsonString(Schema.Struct({ headSha: Schema.String })),
    outcome: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
    head_sha: Schema.NullOr(Schema.String),
    snapshot: Schema.NullOr(
      Schema.fromJsonString(
        Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }),
      ),
    ),
  }),
);

/** A repository with one commit and nothing else, built with none of this machine's config. */
const plainRepository = (root: string, name: string, branch = "main") => {
  const repo = NodePath.join(root, name);
  NodeFS.mkdirSync(repo, { recursive: true });
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  git("init", `--initial-branch=${branch}`);
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "Widgets\n");
  git("add", "-A");
  git("commit", "-m", "First");
  return { repo, git };
};

const writeTranscript = (name: string, log: ReadonlyArray<string>) => {
  const evidence = NodePath.join(repoRoot, ".e2e/evidence/local-guides");
  NodeFS.mkdirSync(evidence, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(evidence, `${name}.txt`), log.join("\n\n"));
};

const attemptsOf = (home: string, key: string) =>
  Schema.decodeUnknownSync(AttemptRows)(
    readRows(
      home,
      `SELECT a.capture, a.outcome, a.error, a.head_sha, a.snapshot FROM review_attempts a
       JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '${key}' ORDER BY a.rowid`,
    ),
  );

test(
  "a guide of local changes is written from the CLI, read without touching the repository or GitHub",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "local-guides";
    const fake: FakeGitHub = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    const start = () =>
      startFakeInstance(name, fake, ["--claude", claude.file, "--watch-interval", "600000"]);
    try {
      const fixture = localRepoFixture(root);
      const run = start();
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      const local = (args: ReadonlyArray<string>, cwd = fixture.repo) =>
        cli(cwd, ["local", ...args]);
      await switchOn({ app, screen, browser }, run.openUrl);
      await app.screenshot("local-guides-access");

      const fingerprint = fixture.fingerprint();
      await fake.resetStats();

      // The working tree against origin/main: committed, uncommitted, deleted and untracked
      // changes; ignored files out; the repository's own clean filter never run.
      const first = local(["guide", "--description", "Raise the limit and flag it", "--json"]);
      expect(first.code).toBe(0);
      const started = decodeGenerate(first.stdout);
      expect(started.outcome).toBe("started");
      expect(started.status).toMatchObject({ name: "widgets", branch: "feature/limits" });
      const key = started.status.key;
      expect(key).toMatch(/^local:[0-9a-f]{16}$/);
      const waited = decodeWait(local(["wait", "--timeout", "120", "--json"]).stdout);
      expect(waited).toMatchObject({
        finished: true,
        status: { state: "ready", latestRevision: 1 },
      });
      const read = decodeRead(local(["read", "--json"]).stdout);
      expect(read.guide?.content.summary).toEqual(["A guide written by the stand-in agent."]);
      expect(claude.prompts().at(-1)?.prompt).toContain("then `manualCheck`");
      expect(read.guide?.content.manualCheck).toEqual({
        _tag: "nothing",
        reason: "The stand-in agent never suggests checks.",
      });
      expect(read.status.run).toMatchObject({
        baseRef: "origin/main",
        head: "working-tree",
        commits: 1,
        uncommitted: true,
        description: "Raise the limit and flag it",
      });
      // `.ts` files carry the repository's filter: their uncommitted content stays out, and
      // the snapshot keeps them as committed.
      expect(read.status.run?.leftOut.map((file) => [file.path, file.reason])).toEqual([
        ["src/flags.ts", "filtered"],
        ["src/limits.ts", "filtered"],
      ]);
      const firstAttempt = attemptsOf(run.home, key)[0];
      expect(firstAttempt?.snapshot?.files.map((file) => file.path).toSorted()).toEqual([
        ".gitattributes",
        "src/limits.ts",
        "src/retired.ts",
      ]);
      expect(fixture.fingerprint()).toBe(fingerprint);
      expect(fixture.filterRan()).toBe(false);

      // Nothing new: no agent starts, and plain output says the guide is current.
      const turns = claude.runs().length;
      const again = local(["guide"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe(
        "Nothing changed since revision 1. The guide is current.\nRead it: prkit local read\n",
      );
      expect(claude.runs().length).toBe(turns);

      // A change is the same review's next revision, from a subfolder too.
      fixture.write("docs/limits.md", "# Limits\n\nThe limit is two.\n");
      const changed = local(["guide", "--json"], NodePath.join(fixture.repo, "src"));
      expect(decodeGenerate(changed.stdout)).toMatchObject({
        outcome: "started",
        status: { key },
      });
      expect(decodeWait(local(["wait", "--timeout", "120", "--json"]).stdout).status).toMatchObject(
        {
          state: "ready",
          latestRevision: 2,
        },
      );

      // A branch's last commit leaves the uncommitted work out.
      const branchTip = local(["guide", "--branch", "feature/limits", "--json"]);
      expect(branchTip.code).toBe(0);
      expect(decodeGenerate(branchTip.stdout).status.key).toBe(key);
      const branchWait = decodeWait(
        local(["wait", "--branch", "feature/limits", "--timeout", "120", "--json"]).stdout,
      );
      expect(branchWait.status).toMatchObject({ state: "ready", latestRevision: 3 });
      expect(branchWait.status.run).toMatchObject({
        head: "branch",
        uncommitted: false,
        leftOut: [],
      });
      expect(
        attemptsOf(run.home, key)
          .at(-1)
          ?.snapshot?.files.map((file) => file.path),
      ).toEqual(["src/limits.ts"]);

      // Problems with the repository: exit 1 with the reason, and no review.
      const problems = scratchRoot();
      const settled = plainRepository(problems, "settled");
      settled.git("update-ref", "refs/remotes/origin/main", "HEAD");
      const lonely = plainRepository(problems, "lonely", "dev");
      const orphaned = plainRepository(problems, "orphaned");
      orphaned.git("checkout", "--orphan", "unrelated");
      NodeFS.writeFileSync(NodePath.join(orphaned.repo, "README.md"), "Elsewhere\n");
      orphaned.git("commit", "-am", "Unrelated");
      for (const [cwd, args, message] of [
        [problems, [], "isn't inside a git repository."],
        [
          settled.repo,
          [],
          "Nothing differs between `origin/main` and your working tree on `main`.",
        ],
        [lonely.repo, [], "prkit couldn't find a base branch: it tried"],
        [orphaned.repo, ["--base", "main"], "`unrelated` shares no history with `main`."],
      ] as const) {
        const refused = local(["guide", ...args], cwd);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(message);
      }
      NodeFS.rmSync(problems, { recursive: true, force: true });
      expect(decodeList(local(["list", "--json"]).stdout).items.map((item) => item.key)).toEqual([
        key,
      ]);

      // Read only refuses to start one, and still reads.
      await outsideAccess({ screen }, "Read only");
      expect(local(["guide"]).code).toBe(4);
      expect(local(["read", "--json"]).code).toBe(0);
      await outsideAccess({ screen }, "Read and start work");

      // Stop ends a guide while it is written.
      claude.hold();
      fixture.write("docs/limits.md", "# Limits\n\nThe limit is two, and a flag turns it on.\n");
      expect(decodeGenerate(local(["guide", "--json"]).stdout).outcome).toBe("started");
      const stopped = local(["stop"]);
      expect(stopped.stdout).toBe(
        "Stopped the guide of widgets · feature/limits. Its revisions stay readable.\n",
      );
      claude.release();
      expect(decodeRead(local(["read", "--json"]).stdout).status).toMatchObject({
        state: "stopped",
        latestRevision: 3,
      });

      expect((await fake.stats()).log).toEqual([]);
      expect(cli(fixture.repo, ["guide", "list", "--json"]).stdout).not.toContain("local:");
      expect(cli(fixture.repo, ["inbox", "--json"]).stdout).not.toContain("local:");
      await screen.getByRole("link", "Inbox").tap();
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
      // The local review has a tab in the strip; the Inbox itself never lists it.
      await expect(screen.getByRole("main").getByText(/widgets/)).toHaveCount(0);
      await app.screenshot("local-guides-inbox");

      // A restart mid-attempt writes the guide from the snapshot that attempt took.
      claude.hold();
      const turnsBefore = claude.runs().length;
      fixture.write("docs/limits.md", "# Limits\n\nWritten before the restart.\n");
      expect(decodeGenerate(local(["guide", "--json"]).stdout).outcome).toBe("started");
      await expect
        .poll(() => claude.runs().length, { timeout: 30_000 })
        .toBeGreaterThan(turnsBefore);
      stopFakeInstance(name, { keepHome: true });
      fixture.write("docs/after-restart.md", "Written while prkit was closed.\n");
      claude.release();
      start();
      const resumed = decodeWait(local(["wait", "--timeout", "120", "--json"]).stdout);
      expect(resumed.status).toMatchObject({ state: "ready", latestRevision: 4 });
      const [interrupted, rerun] = attemptsOf(run.home, key).slice(-2);
      expect(interrupted).toMatchObject({ outcome: "failed", error: "interrupted" });
      expect(rerun?.outcome).toBe("accepted");
      expect(rerun?.capture.headSha).toBe(interrupted?.capture.headSha);
      expect(rerun?.head_sha).toBe(interrupted?.capture.headSha);
      expect(rerun?.snapshot?.files.map((file) => file.path)).not.toContain(
        "docs/after-restart.md",
      );

      expect(fixture.filterRan()).toBe(false);
      expect(await fake.writes()).toEqual([]);
    } finally {
      writeTranscript("cli-transcript", log);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("a guide of local changes with the user's Claude", { tags: ["agent"] }, () => {
  test(
    "Claude writes a guide of a realistic local change before a pull request exists",
    { timeout: GUIDE_WAIT + 2 * 60_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const name = "local-guides-agent";
      const fake = await startFakeGitHub(name);
      const root = scratchRoot();
      const log: Array<string> = [];
      try {
        const shop = plainRepository(root, "shop");
        const write = (path: string, content: string) => {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(shop.repo, path)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(shop.repo, path), content);
        };
        write(
          "src/cart.js",
          "export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\n",
        );
        shop.git("add", "-A");
        shop.git("commit", "-m", "Add the cart total");
        shop.git("update-ref", "refs/remotes/origin/main", "HEAD");
        shop.git("checkout", "-b", "feature/discounts");
        write(
          "src/cart.js",
          [
            "export const total = (items, discount = null) => {",
            "  const sum = items.reduce((total, item) => total + item.price * item.quantity, 0);",
            "  if (discount === null) return sum;",
            "  if (discount.percent < 0 || discount.percent > 100) throw new RangeError('discount');",
            "  return Math.round(sum * (100 - discount.percent)) / 100;",
            "};",
            "",
          ].join("\n"),
        );
        shop.git("commit", "-am", "Count quantities in the total");
        write(
          "src/discounts.js",
          "export const parseDiscount = (code) => {\n  const match = /^SAVE(\\d{1,2})$/.exec(code);\n  return match === null ? null : { percent: Number(match[1]) };\n};\n",
        );
        write(
          "test/cart.test.js",
          "import { total } from '../src/cart.js';\n\nconsole.assert(total([{ price: 10, quantity: 2 }], { percent: 50 }) === 10);\n",
        );
        const fingerprint = NodeChildProcess.execFileSync("git", ["status", "--porcelain=v2"], {
          cwd: shop.repo,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        const claude = setUpRealClaude(name);
        const run = startFakeInstance(name, fake, [
          "--watch-interval",
          "600000",
          "--claude",
          claude.file,
        ]);
        const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
        await emulateOsColorScheme(browser, "light");
        await switchOn({ app, screen, browser }, run.openUrl);
        const started = cli(shop.repo, [
          "local",
          "guide",
          "--description",
          "Count item quantities in the cart total and accept a percentage discount code.",
          "--json",
        ]);
        expect(started.code).toBe(0);
        const waitStep = () =>
          decodeWait(cli(shop.repo, ["local", "wait", "--timeout", "600", "--json"]).stdout);
        let waited = waitStep();
        for (let spent = 600_000; !waited.finished && spent < GUIDE_WAIT; spent += 600_000)
          waited = waitStep();
        expect(waited.status).toMatchObject({ state: "ready", latestRevision: 1 });
        const read = decodeRead(cli(shop.repo, ["local", "read", "--json"]).stdout);
        const covered = new Set(
          read.guide?.content.chapters.flatMap((chapter) => chapter.files.map((file) => file.path)),
        );
        expect([...covered].toSorted()).toEqual([
          "src/cart.js",
          "src/discounts.js",
          "test/cart.test.js",
        ]);
        expect(read.guide?.content.summary.join(" ").length).toBeGreaterThan(40);
        const pairs = (read.guide?.content.chapters ?? []).flatMap((chapter) =>
          chapter.pseudocode === null || typeof chapter.pseudocode === "string" ? [] : [chapter.id],
        );
        console.info(`chapter before/after: ${pairs.join(", ") || "none"}`);
        await app.open(`${run.url}/local/${decodeGenerate(started.stdout).status.key}`);
        await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 30_000 });
        await expect(browser.locator("[data-pseudocode-pair]")).toHaveCount(pairs.length);
        if (pairs[0] !== undefined) {
          await browser
            .locator(`[data-chapter-id="${pairs[0]}"] [data-pseudocode-pair]`)
            .scrollIntoView();
          await screenshotLightAndDark(app, browser, "local-guide-chapter-before-after");
        }
        writeTranscript("agent-guide", [...log, JSON.stringify(read.guide, null, 2)]);
        expect(
          NodeChildProcess.execFileSync("git", ["status", "--porcelain=v2"], {
            cwd: shop.repo,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" },
          }),
        ).toBe(fingerprint);
        expect(await fake.writes()).toEqual([]);
      } finally {
        writeTranscript("agent-transcript", log);
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
