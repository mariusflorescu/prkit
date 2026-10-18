import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ContextSeed } from "../scripts/fake-github/context.ts";
import { readRun, repoRoot } from "../scripts/verify-run.ts";

const Ready = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("ready"), url: Schema.String }),
);
const decodeReady = Schema.decodeUnknownOption(Ready);
const Stats = Schema.fromJsonString(
  Schema.Struct({
    requests: Schema.Number,
    points: Schema.Number,
    rest: Schema.Number,
    refused: Schema.Number,
    mergedInSearch: Schema.Number,
    byKind: Schema.Record(Schema.String, Schema.Number),
    /** The latest requests, oldest first. */
    log: Schema.Array(
      Schema.Struct({
        at: Schema.String,
        kind: Schema.String,
        status: Schema.Number,
        cost: Schema.Number,
      }),
    ),
  }),
);
const decodeStats = Schema.decodeUnknownSync(Stats);
const Writes = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ kind: Schema.String, input: Schema.Json })),
);
const decodeWrites = Schema.decodeUnknownSync(Writes);
const decodePull = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, head: Schema.String, runs: Schema.Array(Schema.Number) }),
  ),
);

type Reviewer = { login: string } | { team: string };
const reviewerQuery = (who: Reviewer) =>
  "login" in who
    ? `login=${encodeURIComponent(who.login)}`
    : `team=${encodeURIComponent(who.team)}`;

/**
 * A fake GitHub (scripts/fake-github.ts) and a prkit instance that reads only it, so
 * budget journeys spend nothing of the real accounts. Stop both in a `finally`.
 * `stacks: false` makes it a host without stacks, like GitHub Enterprise Server.
 * `secondAccount` adds a second gh config dir, for `budget-second`.
 */
export const startFakeGitHub = async (
  name: string,
  { stacks = true, secondAccount = false } = {},
) => {
  const home = NodePath.join(repoRoot, ".e2e", "fake", name);
  NodeFS.rmSync(home, { recursive: true, force: true });
  NodeFS.mkdirSync(home, { recursive: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/fake-github.ts"),
      "--home",
      home,
      ...(stacks ? [] : ["--no-stacks"]),
      ...(secondAccount ? ["--second-account"] : []),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`The fake GitHub exited (${code}).`)));
    if (child.stdout === null) return reject(new Error("The fake GitHub has no stdout."));
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
      Option.match(decodeReady(line), { onNone: () => {}, onSome: (ready) => resolve(ready.url) }),
    );
  });
  const budget = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ core: Schema.Int, graphql: Schema.Int })),
  )(await (await fetch(`${url}/__fake/budget`)).text());
  if (budget.core !== 5000 || budget.graphql !== 5000)
    throw new Error("The fresh fake GitHub budget is not full.");
  const budgetDir = NodePath.join(repoRoot, ".e2e", "evidence", "u70-r1", "budgets");
  NodeFS.mkdirSync(budgetDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(budgetDir, `${name}.json`), JSON.stringify(budget));
  const post = (path: string) => fetch(`${url}/__fake/${path}`, { method: "POST" });
  return {
    url,
    home,
    stats: async () => decodeStats(await (await fetch(`${url}/__fake/stats`)).text()),
    /** Every write prkit sent, oldest first, as `{ kind, input }`. */
    writes: async () => decodeWrites(await (await fetch(`${url}/__fake/writes`)).text()),
    /** A PR's GraphQL node id, head sha and workflow run ids, as the fake answers them. */
    pull: async (pr: number) =>
      decodePull(await (await fetch(`${url}/__fake/pull?pr=${pr}`)).text()),
    limit: (resource: "graphql" | "core", seconds: number) =>
      post(`limit?resource=${resource}&seconds=${seconds}`),
    /** Every answer, or only `resource`'s, waits `ms`. */
    latency: (ms: number, resource?: "graphql" | "core") =>
      post(`latency?ms=${ms}${resource === undefined ? "" : `&resource=${resource}`}`),
    archive: (repo: string) => post(`archive?repo=${repo}`),
    /** Only `count` requests (or points, for graphql) are left in the window, like GitHub's header says. */
    remaining: (resource: "graphql" | "core", count: number) =>
      post(`remaining?resource=${resource}&count=${count}`),
    /** What the PR says besides its diff: check runs, review threads and the issues it closes. Replaces the last seed. */
    context: async (pr: number, seed: ContextSeed) => {
      const response = await fetch(`${url}/__fake/context?pr=${pr}`, {
        method: "POST",
        body: JSON.stringify(seed),
      });
      if (!response.ok) throw new Error(`The fake refused the seed: ${await response.text()}`);
    },
    resetStats: () => post("reset-stats"),
    comment: (pr: number, size = 0) => post(`comment?pr=${pr}&size=${size}`),
    push: (pr: number) => post(`push?pr=${pr}`),
    gitHead: (pr: number, sha: string) => post(`git-head?pr=${pr}&sha=${sha}`),
    files: (
      pr: number,
      files: ReadonlyArray<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch: string;
      }>,
    ) => fetch(`${url}/__fake/files?pr=${pr}`, { method: "POST", body: JSON.stringify(files) }),
    /** A push that also rewrites `src/change-<file>.ts`: new text, new sha. Every other file stays. */
    pushEdit: (pr: number, file: number) => post(`push?pr=${pr}&edit=${file}`),
    /** A push that moves only `src/change-<file>.ts`'s hunk to other lines, like a merged base: same text, new sha. */
    pushShift: (pr: number, file: number) => post(`push?pr=${pr}&shift=${file}`),
    /** The head's file texts the diff viewer reads, by path; any other path reads `export {};`. */
    texts: (pr: number, texts: Record<string, string>) =>
      fetch(`${url}/__fake/texts?pr=${pr}`, { method: "POST", body: JSON.stringify(texts) }),
    conflict: (pr: number) => post(`conflict?pr=${pr}`),
    checking: (pr: number) => post(`checking?pr=${pr}`),
    require: (pr: number) => post(`require?pr=${pr}`),
    merge: (pr: number) => post(`merge?pr=${pr}`),
    close: (pr: number) => post(`close?pr=${pr}`),
    draft: (pr: number) => post(`draft?pr=${pr}`),
    ready: (pr: number, minutesAgo = 0) => post(`ready?pr=${pr}&minutes=${minutesAgo}`),
    shape: (
      pr: number,
      shape: { additions?: number; deletions?: number; files?: number; opened?: number },
    ) =>
      post(
        `shape?${new URLSearchParams([
          ["pr", String(pr)],
          ...Object.entries(shape).map(([key, value]): [string, string] => [key, String(value)]),
        ])}`,
      ),
    requestReview: (pr: number, who: Reviewer, minutesAgo = 0) =>
      post(`request-review?pr=${pr}&${reviewerQuery(who)}&minutes=${minutesAgo}`),
    unrequest: (pr: number, who: Reviewer) => post(`unrequest?pr=${pr}&${reviewerQuery(who)}`),
    unreadable: (pr: number) => post(`unreadable?pr=${pr}`),
    /** `message` is what GitHub says about the refusal; without one the answer is `{}`. */
    fail: (kind: string, times: number, status = 502, message?: string) =>
      post(
        `fail?kind=${encodeURIComponent(kind)}&status=${status}&times=${times}${message === undefined ? "" : `&message=${encodeURIComponent(message)}`}`,
      ),
    behind: (pr: number, by: number) => post(`behind?pr=${pr}&by=${by}`),
    /** Who opened the PR and its description, either one. */
    describe: (pr: number, given: { author?: string; body?: string }) =>
      fetch(`${url}/__fake/describe?pr=${pr}`, { method: "POST", body: JSON.stringify(given) }),
    checks: (pr: number, status: "queued" | "in_progress" | "completed") =>
      post(`checks?pr=${pr}&status=${status}`),
    stop: () => {
      child.kill("SIGTERM");
    },
  };
};
export type FakeGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;

/**
 * A prkit instance of the journey's own, on this machine's real accounts unless `extra`
 * points it at a fake, for a journey that restarts it. Stop it with `stopFakeInstance`.
 */
export const startInstance = (name: string, extra: ReadonlyArray<string> = []) => {
  NodeChildProcess.execFileSync(
    process.execPath,
    ["scripts/verify-app.ts", "start", "--name", name, "--detach", ...extra],
    { cwd: repoRoot, stdio: "ignore" },
  );
  return Option.getOrThrowWith(readRun(name), () => new Error(`${name} wrote no run file.`));
};

export const startFakeInstance = (
  name: string,
  fake: FakeGitHub,
  extra: ReadonlyArray<string> = [],
) => startInstance(name, ["--github-api", fake.url, "--gh-home", fake.home, ...extra]);

/** Stops an instance a journey started, fake or not, and keeps or removes its home. */
export const stopFakeInstance = (name: string, options: { keepHome: boolean }) =>
  NodeChildProcess.execFileSync(
    process.execPath,
    ["scripts/verify-app.ts", "stop", "--name", name, ...(options.keepHome ? ["--keep-home"] : [])],
    { cwd: repoRoot, stdio: "ignore" },
  );
