import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AccountId,
  type AgentCatalog,
  AgentInstanceId,
  type AttemptId,
  type DiffSnapshot,
  type Guide,
  type GuidePatch,
  PullRequestKey,
} from "@prkit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { AgentError, type AgentEvent, type AgentProvider } from "../agents/AgentProvider.ts";
import { Agents } from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import * as McpTokens from "../mcp/McpTokens.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { RepoCache } from "../repo/RepoCache.ts";
import * as GuideConfigStore from "./GuideConfigStore.ts";
import * as GuideSettingsStore from "./GuideSettingsStore.ts";
import * as Reviews from "./Reviews.ts";

// A guide turn through the real Reviews service, SQLite and MCP tokens. The agent is a
// script that calls submit_guide and revise_guide the way the MCP handlers do; GitHub
// and git answer with one fixed pull request. A real agent can't be made to call a
// tool twice, or to send a broken guide, on demand.

const KEY = PullRequestKey.make("github.com/acme/widgets#1");
const ACCOUNT = AccountId.make("github.com/octocat");
const HEAD = "0fb0d774fe3716d1dfb9ea6c6305de8c4e7ec09d";
const BASE = "ab30ea7c8beec5a220e2b0f925d751574aea0d7b";

const SNAPSHOT: DiffSnapshot = {
  files: [
    {
      path: "src/limits.js",
      previousPath: null,
      status: "added",
      additions: 3,
      deletions: 0,
      patch: {
        _tag: "text",
        patch:
          'diff --git a/src/limits.js b/src/limits.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/limits.js\n@@ -0,0 +1,3 @@\n+export const MAX_URL_LENGTH = 2048;\n+export const MAX_CODE_LENGTH = 16;\n+export const BLOCKED_SCHEMES = ["javascript:"];\n',
      },
    },
    {
      path: "src/server.js",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: {
        _tag: "text",
        patch:
          "diff --git a/src/server.js b/src/server.js\n--- a/src/server.js\n+++ b/src/server.js\n@@ -10,3 +10,3 @@ export function shorten(url) {\n   const code = randomCode();\n-  links.set(code, url);\n+  if (checkUrl(url) === null) links.set(code, url);\n   return code;\n",
      },
    },
  ],
};
const PULL = {
  title: "Check link limits",
  body: "Rejects links that are too long.",
  html_url: "https://github.com/acme/widgets/pull/1",
  state: "open",
  merged_at: null,
  user: { login: "octocat" },
  author_association: "OWNER",
  head: { sha: HEAD, ref: "feat/limits", repo: { full_name: "acme/widgets" } },
  base: {
    sha: BASE,
    ref: "main",
    repo: { id: 1296269, name: "widgets", owner: { login: "acme" } },
  },
};
const CLAUDE = AgentInstanceId.make("claude");
const CATALOG: AgentCatalog = {
  providers: [
    {
      instance: CLAUDE,
      kind: "claude",
      label: "Claude",
      accent: null,
      enabled: true,
      isDefault: true,
      configDir: null,
      binaryPath: null,
      environment: [],
      login: "shared",
      group: "claude:default",
      version: "2.1.999",
      state: { _tag: "ready", detail: "Claude Max subscription", ownLogin: false },
      models: [
        {
          slug: "claude-fable-5-1",
          name: "Claude Fable 5.1",
          description: null,
          isDefault: true,
          options: [],
          blocked: null,
        },
      ],
    },
  ],
};

const FLOW = {
  title: "Storing a link",
  nodes: [
    { id: "shorten", label: "shorten(url)", status: "changed" as const, chapter: "server" },
    { id: "check", label: "checkUrl", status: "added" as const, chapter: "limits" },
  ],
  edges: [{ from: "shorten", to: "check" }],
};
const rated = (file: string) => ({
  level: "low" as const,
  reasons: [{ text: "A plain check.", file }],
});
const GUIDE: Guide = {
  summary: ["Checks a link against its limits before storing it."],
  flow: FLOW,
  risk: { level: "low", reasons: [{ text: "Plain checks, easy to follow.", chapter: "limits" }] },
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: ["src/limits.js"],
      risk: rated("src/limits.js"),
    },
    {
      id: "server",
      title: "The server checks them",
      kind: "supporting",
      body: "A link is stored only when it passes.",
      files: ["src/server.js"],
      risk: rated("src/server.js"),
    },
  ],
};
/** Both chapters claim `src/server.js`. */
const REJECTED: Guide = {
  ...GUIDE,
  summary: ["Checks a link against its limits."],
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: ["src/limits.js", "src/server.js"],
      risk: rated("src/limits.js"),
    },
    {
      id: "server",
      title: "The server checks them",
      kind: "supporting",
      body: "A link is stored only when it passes.",
      files: ["src/server.js"],
      risk: rated("src/server.js"),
    },
  ],
};
/** Moves `src/server.js` out of `limits`, but pins a note to a line the diff doesn't show. */
const MISPLACED_NOTE: GuidePatch = {
  summary: ["Rejects links over 2048 characters before storing them."],
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: [{ path: "src/limits.js", annotations: [{ line: 9, text: "The longest link." }] }],
      risk: rated("src/limits.js"),
    },
  ],
};
/** What `REJECTED` becomes with `MISPLACED_NOTE`, sent whole. */
const MISPLACED: Guide = {
  ...GUIDE,
  summary: ["Rejects links over 2048 characters before storing them."],
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: [{ path: "src/limits.js", annotations: [{ line: 9, text: "The longest link." }] }],
      risk: rated("src/limits.js"),
    },
    {
      id: "server",
      title: "The server checks them",
      kind: "supporting",
      body: "A link is stored only when it passes.",
      files: ["src/server.js"],
      risk: rated("src/server.js"),
    },
  ],
};
const FIXED_NOTE: GuidePatch = {
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: [{ path: "src/limits.js", annotations: [{ line: 1, text: "The longest link." }] }],
      risk: rated("src/limits.js"),
    },
  ],
};

/** One agent turn: what the agent does with prkit's tools, then the events its process reports. */
type Turn = (attemptId: AttemptId) => Effect.Effect<ReadonlyArray<AgentEvent>>;

/** Claude, as far as Reviews can tell: each turn runs the next script the test hands it. */
const scriptedAgents = (turns: Queue.Queue<Turn>) =>
  Layer.effect(
    Agents,
    Effect.gen(function* () {
      const tokens = yield* McpTokens.McpTokens;
      const provider = {
        instance: CLAUDE,
        kind: "claude",
        label: "Claude",
        group: "claude:default",
        version: Effect.succeed("2.1.999"),
        retire: Effect.void,
        streamsGuideInput: true,
        check: Effect.succeed({
          _tag: "ready",
          detail: "Claude Max subscription",
          ownLogin: false,
        }),
        models: () => Effect.succeed([]),
        hasSession: () => Effect.succeed(true),
        // The MCP handlers find the attempt from the turn's bearer token the same way.
        runTurn: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const caller = yield* tokens.resolve(input.mcp.bearerToken);
              if (caller?._tag !== "guide")
                return Stream.fail(
                  new AgentError({ reason: "agent", message: "The turn has no attempt token." }),
                );
              const events = yield* (yield* Queue.take(turns))(caller.attemptId);
              return Stream.fromIterable<AgentEvent>([
                { _tag: "session", sessionId: "session-1" },
                { _tag: "mcp-ready" },
                ...events,
                { _tag: "finished", outcome: "completed", message: null },
              ]);
            }),
          ),
        ownLogin: null,
      } satisfies AgentProvider;
      return Agents.of({
        get: () => Effect.succeed(provider),
        usable: (instance) => Effect.succeed(instance),
        sameGroup: (instance) => Effect.succeed([instance]),
        catalog: () => Effect.succeed(CATALOG),
        invalidate: Effect.void,
        slots: yield* Semaphore.make(2),
        signIn: () => Stream.empty,
        signOut: () => Effect.succeed(CATALOG),
        create: () => Effect.succeed(CATALOG),
        update: () => Effect.succeed(CATALOG),
        remove: () => Effect.succeed(CATALOG),
        reset: () => Effect.succeed(CATALOG),
      });
    }),
  );

const Config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "prkit-reviews-",
    });
    return ServerConfig.ServerConfig.of({
      host: ServerConfig.SERVER_HOST,
      port: 0,
      home,
      dbPath: ":memory:",
      webDist: Option.none(),
      devWebOrigin: Option.none(),
      authToken: Redacted.make("test"),
      watchIntervalMs: 60_000,
      devReviewRequested: [],
      version: "0.0.0",
      startedAt: "2026-10-11T00:00:00.000Z",
    });
  }),
);

const GitHub = Layer.mergeAll(
  Layer.mock(GitHubAccounts, {
    list: () => Effect.succeed({ accounts: [], addedConfigDirs: [] }),
    apiBase: () => "https://api.github.com",
  }),
  Layer.mock(GitHubApi, {
    rest: (_account, _path, schema) => Schema.decodeEffect(schema)(PULL).pipe(Effect.orDie),
  }),
  Layer.unwrap(
    SubscriptionRef.make(0).pipe(
      Effect.map((presence) =>
        Layer.mock(PullRequests, {
          presence,
          context: () =>
            Effect.succeed({
              checks: { _tag: "read", value: { failing: [], pending: [] } },
              threads: { _tag: "read", value: [] },
              issues: { _tag: "read", value: { total: 0, items: [] } },
            }),
        }),
      ),
    ),
  ),
);

const Git = Layer.unwrap(
  Effect.gen(function* () {
    const { home } = yield* ServerConfig.ServerConfig;
    return Layer.mock(RepoCache, {
      isolatedGitEnv: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
      },
      local: {
        copyOf: () => home,
        identify: () => Effect.die("unused"),
        capture: () => Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        contents: () => Effect.die("unused"),
        forget: () => Effect.die("unused"),
        sweep: () => Effect.die("unused"),
      },
      checkout: (_ref, worktree) => ({ repo: worktree, worktree, gitDir: worktree }),
      verifyCheckout: () => Effect.succeed(undefined),
      prepare: () =>
        Effect.succeed({
          worktree: home,
          checkout: { repo: home, worktree: home, gitDir: home },
          headSha: HEAD,
          baseSha: BASE,
          mergeBaseSha: BASE,
          snapshot: SNAPSHOT,
          since: { _tag: "none" },
        }),
      keepRevision: () => Effect.void,
      worktreePath: () => home,
      fixerPath: () => home,
      listWorktrees: () => Effect.succeed([]),
      removeWorktree: () => Effect.succeed(true),
    });
  }),
);

const harness = (turns: Queue.Queue<Turn>) =>
  Reviews.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        GuideConfigStore.layer,
        GuideSettingsStore.layer,
        scriptedAgents(turns),
        Git,
        Layer.mock(HttpServer.HttpServer, {
          address: NetAddress.inetAddressFromIpStringUnsafe(ServerConfig.SERVER_HOST, 4100),
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(GitHub, McpTokens.layer, Config)),
    Layer.provideMerge(
      Layer.effectDiscard(runMigrations()).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

interface Harness {
  readonly reviews: Effect.Success<typeof Reviews.make>;
  readonly turns: Queue.Queue<Turn>;
  readonly sql: SqlClient.SqlClient;
}

const run = <A, E>(test: (harness: Harness) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const turns = yield* Queue.unbounded<Turn>();
      return yield* Effect.gen(function* () {
        const reviews = yield* Reviews.Reviews;
        return yield* test({ reviews, turns, sql: yield* SqlClient.SqlClient });
      }).pipe(Effect.provide(harness(turns)));
    }).pipe(Effect.scoped, Effect.provideService(References.MinimumLogLevel, "Warn")),
  );

/** What the agent reads back from a tool call: the receipt's message, or why it was refused. */
const told = <E extends { readonly message: string }>(
  call: Effect.Effect<{ readonly message: string }, E>,
) =>
  call.pipe(Effect.match({ onSuccess: (receipt) => receipt.message, onFailure: (e) => e.message }));

/**
 * Runs tool calls the way two HTTP requests arrive: at once, each fiber yielding after
 * every step. SQLite answers synchronously, so without the yields one call would finish
 * before the other started.
 */
const inFlight = <A>(calls: ReadonlyArray<Effect.Effect<A>>) =>
  Effect.all(calls, { concurrency: "unbounded" }).pipe(
    Effect.provideService(References.MaxOpsBeforeYield, 32),
  );

const SETTLED = new Set(["watching", "failed", "done"]);

/** Starts a guide on the pull request, runs `turn` as the agent's turn, and waits until the review settles. */
const guideWith = ({ reviews, turns }: Harness, turn: Turn) =>
  Effect.gen(function* () {
    yield* reviews.generate(KEY, ACCOUNT, {
      agent: { instance: CLAUDE, model: "claude-fable-5-1", options: [] },
    });
    const subscribed = yield* Deferred.make<void>();
    const settled = yield* reviews.feed().pipe(
      Stream.tap((event) =>
        event._tag === "index" ? Deferred.succeed(subscribed, undefined) : Effect.void,
      ),
      Stream.filter((event) => event._tag === "changed" && SETTLED.has(event.review.status)),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* Queue.offer(turns, turn);
    yield* Fiber.join(settled);
  });

const STORED = "prkit stored the guide.\n\nEnd your turn now.";
const ALREADY_STORED =
  "prkit already has this attempt's guide, so it won't use this one. End your turn now.";
const NO_REJECTED =
  "prkit has no rejected guide from this attempt to revise. Call submit_guide with the whole guide.";
const SECOND: Guide = { ...GUIDE, summary: ["A second guide for the same attempt."] };
const UNRATED: Guide = {
  summary: ["Checks a link against its limits before storing it."],
  chapters: [
    {
      id: "limits",
      title: "The limits",
      kind: "core",
      body: "Three limits a link must meet.",
      files: ["src/limits.js", "src/server.js"],
    },
  ],
};
const RATING: GuidePatch = {
  risk: { level: "low", reasons: [{ text: "A plain check.", chapter: "limits" }] },
  chapters: [{ ...UNRATED.chapters[0], risk: rated("src/limits.js") }],
};

/** What submit_guide answers `MISPLACED`, and revise_guide the patch that makes it. */
const MISPLACED_ANSWER =
  "The guide has 1 problem. Fix all of them: call revise_guide with only the chapters and fields you change, each chapter whole with its id:\n- `src/limits.js`: additions line 9 is outside the diff hunks, so the note would be hidden. Visible additions lines: 1-3.";

const accepted: AgentEvent = { _tag: "tool-done", id: "call-1", ok: true };

const revisions = (sql: SqlClient.SqlClient) =>
  sql`SELECT revision, json_extract(guide, '$.summary[0]') AS summary FROM review_revisions`;

describe("submit_guide and revise_guide", () => {
  it("after an accepted guide, answers the same guide sent again as stored and refuses another", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            answers.push(yield* told(reviews.submitGuide(attemptId, GUIDE)));
            answers.push(yield* told(reviews.submitGuide(attemptId, GUIDE)));
            answers.push(yield* told(reviews.submitGuide(attemptId, SECOND)));
            return [accepted];
          }),
        );
        expect(answers).toEqual([STORED, STORED, ALREADY_STORED]);
        expect(yield* revisions(harness.sql)).toEqual([
          { revision: 1, summary: "Checks a link against its limits before storing it." },
        ]);
      }),
    ));

  it("of two submit_guide calls in flight at once, stores the first and refuses the second", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          inFlight([
            told(reviews.submitGuide(attemptId, GUIDE)),
            told(reviews.submitGuide(attemptId, SECOND)),
          ]).pipe(
            Effect.map((both) => {
              answers.push(...both);
              return [accepted];
            }),
          ),
        );
        expect(answers).toEqual([STORED, ALREADY_STORED]);
        expect(yield* revisions(harness.sql)).toEqual([
          { revision: 1, summary: "Checks a link against its limits before storing it." },
        ]);
      }),
    ));

  it("a broken submit_guide racing an accepted one leaves the attempt as the accepted one left it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews, sql } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            answers.push(
              ...(yield* inFlight([
                told(reviews.submitGuide(attemptId, GUIDE)),
                told(reviews.submitGuide(attemptId, REJECTED)),
              ])),
            );
            // Nothing was kept for revise_guide: the broken guide arrived after the accepted one.
            answers.push(yield* told(reviews.reviseGuide(attemptId, FIXED_NOTE)));
            return [accepted];
          }),
        );
        expect(answers).toEqual([STORED, ALREADY_STORED, NO_REJECTED]);
        expect(yield* sql`SELECT phase FROM review_attempts`).toEqual([
          { phase: "checking-guide" },
        ]);
        expect(yield* sql`SELECT text FROM review_activity WHERE kind = 'error'`).toEqual([]);
        expect(yield* revisions(harness.sql)).toEqual([
          { revision: 1, summary: "Checks a link against its limits before storing it." },
        ]);
      }),
    ));

  it("revise_guide patches the last rejected guide, refuses a broken patch like submit_guide, and stores the fix", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            answers.push(yield* told(reviews.submitGuide(attemptId, MISPLACED)));
            answers.push(yield* told(reviews.submitGuide(attemptId, REJECTED)));
            answers.push(yield* told(reviews.reviseGuide(attemptId, MISPLACED_NOTE)));
            answers.push(yield* told(reviews.reviseGuide(attemptId, FIXED_NOTE)));
            return [accepted];
          }),
        );
        expect(answers).toEqual([
          MISPLACED_ANSWER,
          "The guide has 2 problems. Fix all of them: call revise_guide with only the chapters and fields you change, each chapter whole with its id:\n- `src/server.js` is in both `limits` and `server` - each file belongs to exactly one chapter.\n- chapter `server` ended up with no files.",
          MISPLACED_ANSWER,
          STORED,
        ]);
        // The fix went onto the guide the broken patch made, not the one submit_guide sent.
        expect(
          yield* harness.sql`SELECT revision, json_extract(guide, '$.summary[0]') AS summary,
            json_extract(guide, '$.chapters[0].files[0].annotations[0].line') AS note_line,
            json_extract(guide, '$.chapters[1].files[0].path') AS server_chapter
            FROM review_revisions`,
        ).toEqual([
          {
            revision: 1,
            summary: "Rejects links over 2048 characters before storing them.",
            note_line: 1,
            server_chapter: "src/server.js",
          },
        ]);
      }),
    ));

  it("refuses revise_guide before any guide was rejected", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            answers.push(yield* told(reviews.reviseGuide(attemptId, FIXED_NOTE)));
            answers.push(yield* told(reviews.submitGuide(attemptId, GUIDE)));
            return [accepted];
          }),
        );
        expect(answers).toEqual([NO_REJECTED, STORED]);
        expect(yield* revisions(harness.sql)).toEqual([
          { revision: 1, summary: "Checks a link against its limits before storing it." },
        ]);
      }),
    ));
  it("holds a guide to the rating the attempt's frozen signals ask for, and revise_guide adds it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const answers: Array<string> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            answers.push(yield* told(reviews.submitGuide(attemptId, UNRATED)));
            answers.push(yield* told(reviews.reviseGuide(attemptId, RATING)));
            return [accepted];
          }),
        );
        expect(answers[0]).toContain("`risk` is missing");
        expect(answers[1]).toContain("prkit stored the guide.");
      }),
    ));
});

describe("drafts", () => {
  it("come back with the attempt's signals and the risk written so far", () =>
    run((harness) =>
      Effect.gen(function* () {
        const { reviews } = harness;
        const shown: Array<{
          readonly signals: ReadonlyArray<string>;
          readonly chapterRisk: ReadonlyArray<string | null>;
        }> = [];
        yield* guideWith(harness, (attemptId) =>
          Effect.gen(function* () {
            yield* reviews
              .submitDraft(attemptId, {
                summary: ["Checks a link against its limits."],
                chapters: [
                  { ...GUIDE.chapters[0], risk: rated("src/limits.js") },
                  { id: "server", title: "The server checks them" },
                ],
              })
              .pipe(Effect.orDie);
            const draft = yield* reviews.draft(KEY, attemptId).pipe(Effect.orDie);
            shown.push({
              signals: draft.normalized.signals.map((signal) => signal._tag),
              chapterRisk: draft.normalized.chapters.map((chapter) => chapter.risk?.level ?? null),
            });
            yield* told(reviews.submitGuide(attemptId, GUIDE));
            return [accepted];
          }),
        );
        expect(shown).toEqual([{ signals: ["untested"], chapterRisk: ["low", null] }]);
      }),
    ));
});
