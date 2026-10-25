import { AccountId, type PullRequestDetail, PullRequestKey } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { GitHubApi, GitHubRequestError } from "../github/GitHubApi.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { PullRequestFingerprint } from "./fingerprint.ts";
import * as PullRequests from "./PullRequests.ts";

// What the watcher's fingerprint read does to a cached pull request detail, through the
// real PullRequests service and SQLite. GitHub is a stand-in whose head the test moves.

const KEY = PullRequestKey.make("github.com/acme/widgets#1");
const ACCOUNT = AccountId.make("github.com/octocat");
const HEAD = "0fb0d774fe3716d1dfb9ea6c6305de8c4e7ec09d";
const NEXT = "ab30ea7c8beec5a220e2b0f925d751574aea0d7b";
const BASE = "5d3f2a1e0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a59";
const UPDATED = "2026-10-11T08:00:00Z";
const PUSHED = "2026-10-11T08:05:00Z";

/** The pull request as GitHub has it right now; a test moves it to simulate a push. */
interface GitHubState {
  head: string;
  updatedAt: string;
  reachable: boolean;
  pullReads: number;
}

const pullJson = (state: GitHubState) => ({
  title: "Check link limits",
  body: null,
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  user: { login: "octocat", avatar_url: "https://avatars.example/octocat" },
  head: { ref: "feat/limits", sha: state.head },
  base: { ref: "main", sha: BASE },
  requested_reviewers: [],
  requested_teams: [],
  labels: [],
  additions: 3,
  deletions: 0,
  changed_files: 1,
  html_url: "https://github.com/acme/widgets/pull/1",
  created_at: "2026-10-10T08:00:00Z",
  updated_at: state.updatedAt,
});
const ACTIONS = {
  repository: {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    autoMergeAllowed: false,
    isArchived: false,
    viewerPermission: "ADMIN",
    viewerDefaultMergeMethod: "SQUASH",
    pullRequest: {
      id: "PR_1",
      headRefName: "feat/limits",
      baseRefName: "main",
      headRef: { name: "feat/limits" },
      reviewDecision: null,
      mergeStateStatus: "CLEAN",
      isMergeQueueEnabled: false,
      isCrossRepository: true,
      viewerCanUpdate: true,
      viewerCanUpdateBranch: true,
      viewerCanClose: true,
      viewerCanReopen: true,
      viewerCanLabel: true,
      viewerCanAssign: true,
      viewerCanEnableAutoMerge: false,
      viewerCanDisableAutoMerge: false,
      autoMergeRequest: null,
      baseRef: null,
      mergeTitle: "",
      mergeBody: "",
      squashTitle: "",
      squashBody: "",
      commits: { nodes: [] },
    },
  },
};

/** One watcher read of the pull request. */
const fingerprint = (head: string, updatedAt: string): PullRequestFingerprint => ({
  title: "Check link limits",
  state: "OPEN",
  isDraft: false,
  updatedAt,
  headRefOid: head,
  baseRefOid: BASE,
  baseRefName: "main",
  reviewDecision: null,
  mergeStateStatus: "CLEAN",
  comments: { totalCount: 0 },
  reviews: { totalCount: 0 },
});

const discovered = {
  accounts: [
    {
      id: ACCOUNT,
      host: "github.com",
      login: "octocat",
      name: null,
      avatarUrl: null,
      configDir: "/gh/octocat",
      status: { _tag: "ready" },
    },
  ],
  home: "/home/octocat",
  addedConfigDirs: [],
  configDirProblems: [],
} as const;

const github = (state: GitHubState) =>
  Layer.mergeAll(
    Layer.mock(GitHubAccounts, {
      list: () => Effect.succeed(discovered),
      known: Effect.succeed(discovered),
      changes: Stream.make(discovered),
      apiBase: () => "https://api.github.com",
    }),
    Layer.mock(GitHubApi, {
      rest: (_account, path, schema) =>
        Effect.suspend(() => {
          if (!state.reachable)
            return Effect.fail(
              new GitHubRequestError({
                accountId: ACCOUNT,
                reason: "network",
                message: "GitHub didn't answer.",
                status: null,
              }),
            );
          if (path.endsWith("/pulls/1")) state.pullReads++;
          const answer = path.endsWith("/pulls/1")
            ? pullJson(state)
            : path.includes("/check-runs")
              ? { check_runs: [] }
              : [];
          return Schema.decodeEffect(schema)(answer).pipe(Effect.orDie);
        }),
      graphql: (_account, _query, schema) =>
        Schema.decodeEffect(schema)(ACTIONS).pipe(
          Effect.orDie,
          Effect.flatMap((data) =>
            data === null ? Effect.die("The GraphQL answer has no data.") : Effect.succeed(data),
          ),
        ),
    }),
  );

const run = <A, E>(
  state: GitHubState,
  test: (pullRequests: Effect.Success<typeof PullRequests.make>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* test(yield* PullRequests.PullRequests);
    }).pipe(
      Effect.provide(
        PullRequests.layer.pipe(
          Layer.provide(github(state)),
          Layer.provide(
            Layer.effectDiscard(runMigrations()).pipe(
              Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
            ),
          ),
        ),
      ),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    ),
  );

/** What the PR page shows of a detail read: the head, and why it wasn't read again. */
const shown = (detail: PullRequestDetail) => ({
  headSha: detail.headSha,
  problem: detail.freshness.problem,
});

describe("PullRequests.observe", () => {
  it("keeps the cached detail for a first fingerprint that matches it, and reads GitHub again once one changes", () => {
    const state: GitHubState = { head: HEAD, updatedAt: UPDATED, reachable: true, pullReads: 0 };
    return run(state, (pullRequests) =>
      Effect.gen(function* () {
        expect(shown(yield* pullRequests.detail(KEY, ACCOUNT))).toEqual({
          headSha: HEAD,
          problem: null,
        });
        yield* pullRequests.observe(KEY, ACCOUNT, "/gh/octocat", fingerprint(HEAD, UPDATED));
        yield* pullRequests.detail(KEY, ACCOUNT);
        expect(state.pullReads).toBe(1);

        state.head = NEXT;
        state.updatedAt = PUSHED;
        yield* pullRequests.observe(KEY, ACCOUNT, "/gh/octocat", fingerprint(NEXT, PUSHED));
        expect(shown(yield* pullRequests.detail(KEY, ACCOUNT))).toEqual({
          headSha: NEXT,
          problem: null,
        });
        expect(state.pullReads).toBe(2);
      }),
    );
  });

  it("reads GitHub again when the first fingerprint is ahead of the cached detail", () => {
    const state: GitHubState = { head: HEAD, updatedAt: UPDATED, reachable: true, pullReads: 0 };
    return run(state, (pullRequests) =>
      Effect.gen(function* () {
        yield* pullRequests.detail(KEY, ACCOUNT);
        state.head = NEXT;
        state.updatedAt = PUSHED;
        yield* pullRequests.observe(KEY, ACCOUNT, "/gh/octocat", fingerprint(NEXT, PUSHED));
        expect(shown(yield* pullRequests.detail(KEY, ACCOUNT))).toEqual({
          headSha: NEXT,
          problem: null,
        });
        expect(state.pullReads).toBe(2);
      }),
    );
  });

  it("answers a changed pull request GitHub can't be read for with the last detail and the reason", () => {
    const state: GitHubState = { head: HEAD, updatedAt: UPDATED, reachable: true, pullReads: 0 };
    return run(state, (pullRequests) =>
      Effect.gen(function* () {
        yield* pullRequests.detail(KEY, ACCOUNT);
        yield* pullRequests.observe(KEY, ACCOUNT, "/gh/octocat", fingerprint(HEAD, UPDATED));
        state.reachable = false;
        yield* pullRequests.observe(KEY, ACCOUNT, "/gh/octocat", fingerprint(NEXT, PUSHED));
        expect(shown(yield* pullRequests.detail(KEY, ACCOUNT))).toEqual({
          headSha: HEAD,
          problem: { _tag: "unavailable", message: "GitHub didn't answer." },
        });
      }),
    );
  });
});
