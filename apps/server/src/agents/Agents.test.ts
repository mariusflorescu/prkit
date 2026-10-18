import * as NodeServices from "@effect/platform-node/NodeServices";
import { type AgentInstanceConfig, AgentInstanceId, defaultInstanceConfig } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as AgentInstancesStore from "./AgentInstances.ts";
import * as Agents from "./Agents.ts";
import * as CodexAgent from "./codex/CodexAgent.ts";

const id = AgentInstanceId.make;

const Config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "prkit-agents-",
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

/**
 * Stand-ins for `claude` and `codex`, so no test reads a real login or runs a real agent. Each
 * fails every command, except `codex login status`, which answers the way a signed-out Codex does.
 */
const FAKE_CLAUDE = "#!/bin/sh\nexit 1\n";
const FAKE_CODEX = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = status ]; then echo "Not logged in" >&2; exit 1; fi
done
exit 1
`;
/** A Codex that never answers. */
const HANGING_CODEX = "#!/bin/sh\nsleep 5\n";

const FakeAgents = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "prkit-fake-agents-" });
    for (const [name, script] of [
      ["claude", FAKE_CLAUDE],
      ["codex", FAKE_CODEX],
      ["hanging-codex", HANGING_CODEX],
    ] as const) {
      yield* fs.writeFileString(`${folder}/${name}`, script);
      yield* fs.chmod(`${folder}/${name}`, 0o755);
    }
    process.env.PRKIT_CLAUDE_PATH = `${folder}/claude`;
    process.env.PRKIT_CODEX_PATH = `${folder}/codex`;
    process.env.PRKIT_TEST_HANGING_CODEX = `${folder}/hanging-codex`;
    // The agents' own folders too: no test reads or links the caller's real logins.
    yield* fs.makeDirectory(`${folder}/codex-home`);
    yield* fs.makeDirectory(`${folder}/claude-config`);
    process.env.CODEX_HOME = `${folder}/codex-home`;
    process.env.CLAUDE_CONFIG_DIR = `${folder}/claude-config`;
  }),
);

const Harness = Layer.effect(Agents.Agents, Agents.make).pipe(
  Layer.provideMerge(AgentInstancesStore.layer),
  Layer.provideMerge(Config),
  Layer.provideMerge(FakeAgents),
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const run = <A, E>(test: Effect.Effect<A, E, Layer.Success<typeof Harness>>) =>
  Effect.runPromise(
    test.pipe(
      Effect.provide(Harness),
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provideService(CodexAgent.CommandTimeout, "300 millis"),
    ),
  );

const side = (changes: Partial<AgentInstanceConfig> = {}): AgentInstanceConfig => ({
  ...defaultInstanceConfig("codex"),
  id: id("codex_side"),
  label: "Side",
  ...changes,
});

const work = (changes: Partial<AgentInstanceConfig> = {}): AgentInstanceConfig => ({
  ...defaultInstanceConfig("claude"),
  id: id("claude_work"),
  label: "Work",
  configDir: "/Users/octocat/.claude-work",
  ...changes,
});

describe("Agents", () => {
  it("builds a provider per instance and builds it again only when its settings change", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        yield* store.create(work());
        const first = yield* agents.get(id("claude_work"));
        expect(first?.group).toBe("claude:/Users/octocat/.claude-work");

        yield* store.update(work({ label: "Day job" }));
        const relabelled = yield* agents.get(id("claude_work"));
        expect(relabelled?.label).toBe("Day job");

        yield* store.update(work({ label: "Day job", configDir: "/Users/octocat/.claude-day" }));
        expect((yield* agents.get(id("claude_work")))?.group).toBe(
          "claude:/Users/octocat/.claude-day",
        );

        yield* store.update(work({ label: "Day job" }));
        const again = yield* agents.get(id("claude_work"));
        yield* store.update(work({ label: "Day job" }));
        expect(yield* agents.get(id("claude_work"))).toBe(again);
      }),
    ));

  it("falls back to the kind's default when an instance is off, and to nothing when both are", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        yield* store.create(work({ enabled: false }));
        expect(yield* agents.get(id("claude_work"))).toBeNull();
        expect(yield* agents.usable(id("claude_work"), "claude")).toBe("claude");
        expect(yield* agents.usable(id("claude_gone"), "claude")).toBe("claude");

        yield* store.update({ ...defaultInstanceConfig("claude"), enabled: false });
        expect(yield* agents.usable(id("claude_work"), "claude")).toBeNull();

        yield* agents.reset(id("claude"));
        expect(yield* agents.usable(id("claude_work"), "claude")).toBe("claude");
      }),
    ));

  it("groups instances by config folder: one group continues another's conversations", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        const { home } = yield* ServerConfig.ServerConfig;
        yield* store.create(work());
        yield* store.create(work({ id: id("claude_same"), label: "Same" }));
        yield* store.create({
          ...defaultInstanceConfig("codex"),
          id: id("codex_side"),
          label: "Side",
        });

        expect(yield* agents.sameGroup(id("claude_work"))).toEqual(["claude_same", "claude_work"]);
        expect(yield* agents.sameGroup(id("claude_gone"))).toEqual(["claude_gone"]);
        // Each Codex instance signs in and keeps sessions in its own prkit folder.
        expect((yield* agents.get(id("codex")))?.group).toBe(`codex:${home}/codex`);
        expect((yield* agents.get(id("codex_side")))?.group).toBe(
          `codex:${home}/codex-instances/codex_side`,
        );
        expect(yield* agents.sameGroup(id("codex_side"))).toEqual(["codex_side"]);
      }),
    ));

  it("removes an added instance with its prkit folder, and never a default", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* ServerConfig.ServerConfig;
        yield* store.create(side());
        const folder = `${home}/codex-instances/codex_side`;
        yield* fs.makeDirectory(folder, { recursive: true });

        yield* agents.remove(id("codex_side"));
        expect(yield* fs.exists(folder)).toBe(false);
        expect(yield* agents.get(id("codex_side"))).toBeNull();

        const refused = yield* agents.remove(id("codex")).pipe(Effect.flip);
        expect(refused.message).toContain("can't be removed");
      }),
    ));

  it("deletes a home holding its own login only once Codex says it is signed out", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* ServerConfig.ServerConfig;
        const folder = `${home}/codex-instances/codex_side`;
        const holdOwnLogin = Effect.gen(function* () {
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(`${folder}/config.toml`, "");
        });

        // No Codex to sign out with: refused, home kept.
        yield* store.create(side({ login: "prkit", binaryPath: "/nonexistent/codex" }));
        yield* holdOwnLogin;
        const noBinary = yield* agents.remove(id("codex_side")).pipe(Effect.flip);
        expect(noBinary.message).toContain("can't find it");
        expect(yield* fs.exists(`${folder}/config.toml`)).toBe(true);

        // A Codex that never answers: the sign-out isn't confirmed, so the home stays.
        yield* store.update(
          side({ login: "prkit", binaryPath: process.env.PRKIT_TEST_HANGING_CODEX ?? null }),
        );
        const timedOut = yield* agents.remove(id("codex_side")).pipe(Effect.flip);
        expect(timedOut.message).toContain("couldn't confirm");
        expect(yield* fs.exists(`${folder}/config.toml`)).toBe(true);
        expect(yield* agents.get(id("codex_side"))).not.toBeNull();

        // Codex says "Not logged in": the home and the instance go.
        yield* store.update(side({ login: "prkit" }));
        yield* agents.remove(id("codex_side"));
        expect(yield* fs.exists(folder)).toBe(false);
        expect(yield* agents.get(id("codex_side"))).toBeNull();
      }),
    ));

  it("refuses to remove an instance a guide or fix is running on", () =>
    run(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const store = yield* AgentInstancesStore.AgentInstances;
        const sql = yield* SqlClient.SqlClient;
        yield* store.create(work());
        yield* sql`INSERT INTO reviews (id, pr_key, account_id, provider, instance_id, status,
          created_at, updated_at) VALUES ('r1', 'github.com/acme/widgets#1', 'github.com/octocat',
          'claude', 'claude_work', '{}', 'now', 'now')`;
        yield* sql`INSERT INTO review_attempts (id, review_id, revision, trigger, run_id, phase,
          started_at, instance_id) VALUES ('a1', 'r1', 1, 'manual', 'run', 'writing', 'now',
          'claude_work')`;

        const refused = yield* agents.remove(id("claude_work")).pipe(Effect.flip);
        expect(refused.message).toBe(
          "Work is busy with a guide, a fix or an answer. Try again when it's done.",
        );
        expect(yield* agents.get(id("claude_work"))).not.toBeNull();

        yield* sql`UPDATE review_attempts SET finished_at = 'now' WHERE id = 'a1'`;
        yield* agents.remove(id("claude_work"));
        expect(yield* agents.get(id("claude_work"))).toBeNull();
      }),
    ));
});

describe("setupOf", () => {
  const resolved = (config: AgentInstanceConfig) => ({
    config,
    environment: {},
    secretsLost: false,
  });

  it("lets a default without a folder keep the one the server started with", () => {
    expect(
      Agents.setupOf(resolved(defaultInstanceConfig("codex")), { CODEX_HOME: "/tmp/e2e-codex" })
        .configDir,
    ).toBe("/tmp/e2e-codex");
    expect(
      Agents.setupOf(resolved(work({ configDir: null })), {
        CLAUDE_CONFIG_DIR: "/tmp/elsewhere",
      }).configDir,
    ).toBeNull();
  });
});

const Secrets = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);

describe("AgentInstances secrets", () => {
  it("keeps sensitive values out of the database and the app, and keeps one sent back blank", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* ServerConfig.ServerConfig;
        yield* store.create(
          work({
            environment: [
              {
                name: "HTTPS_PROXY",
                value: "http://proxy",
                sensitive: false,
                valueRedacted: false,
              },
              { name: "MY_TOKEN", value: "s3cret", sensitive: true, valueRedacted: false },
            ],
          }),
        );

        const read = (yield* store.resolved).find((entry) => entry.config.id === "claude_work");
        expect(read?.environment).toEqual({ HTTPS_PROXY: "http://proxy", MY_TOKEN: "s3cret" });
        expect(read?.config.environment).toEqual([
          { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false, valueRedacted: false },
          { name: "MY_TOKEN", value: "", sensitive: true, valueRedacted: true },
        ]);
        const rows = yield* sql`SELECT environment FROM agent_instances`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ environment: Schema.String }))),
          ),
        );
        expect(rows[0]?.environment).not.toContain("s3cret");
        const file = `${home}/agent-secrets.json`;
        expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600");

        // The edit form sends a kept secret back blank and redacted.
        yield* store.update(
          work({ label: "Day job", environment: read?.config.environment ?? [] }),
        );
        const kept = (yield* store.resolved).find((entry) => entry.config.id === "claude_work");
        expect(kept?.environment["MY_TOKEN"]).toBe("s3cret");

        yield* store.drop(id("claude_work"));
        expect(yield* Schema.decodeEffect(Secrets)(yield* fs.readFileString(file))).toEqual({});
      }),
    ));

  it("fails a save on a secrets file it can't read, and leaves the file as it was", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* ServerConfig.ServerConfig;
        const file = `${home}/agent-secrets.json`;
        const secret = { name: "MY_TOKEN", value: "s3cret", sensitive: true, valueRedacted: false };

        yield* fs.writeFileString(file, "{ not json");
        const damaged = yield* store.create(work({ environment: [secret] })).pipe(Effect.flip);
        expect(damaged._tag).toBe("AgentInstanceError");
        expect(damaged.message).toContain("damaged");
        expect(yield* fs.readFileString(file)).toBe("{ not json");

        yield* fs.remove(file);
        yield* fs.makeDirectory(file);
        const unreadable = yield* store.create(work({ environment: [secret] })).pipe(Effect.flip);
        expect(unreadable.message).toContain(`couldn't read ${file}`);
        expect((yield* fs.stat(file)).type).toBe("Directory");

        // Only a missing file counts as empty.
        yield* fs.remove(file, { recursive: true });
        yield* store.create(work({ environment: [secret] }));
        expect(yield* Schema.decodeEffect(Secrets)(yield* fs.readFileString(file))).toEqual({
          claude_work: { MY_TOKEN: "s3cret" },
        });
      }),
    ));

  it("starts every agent with a damaged secrets file, and flags only those that had secrets", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* ServerConfig.ServerConfig;
        const file = `${home}/agent-secrets.json`;
        yield* store.create(
          work({
            environment: [
              { name: "MY_TOKEN", value: "s3cret", sensitive: true, valueRedacted: false },
            ],
          }),
        );
        yield* store.create(work({ id: id("claude_plain"), label: "Plain" }));
        yield* fs.writeFileString(file, "{ not json");

        // A fresh start: nothing built yet, the file unreadable.
        const agents = yield* Agents.make;
        const catalog = yield* agents.catalog();
        expect(catalog.providers.map((entry) => entry.instance)).toEqual([
          "claude",
          "claude_plain",
          "claude_work",
          "codex",
          "cursor",
        ]);
        const reasons = Object.fromEntries(
          catalog.providers.map((entry) => [
            entry.instance,
            entry.state._tag === "unavailable" ? entry.state.reason : "ready",
          ]),
        );
        expect(reasons["claude_work"]).toBe("secrets");
        expect(reasons["claude_plain"]).not.toBe("secrets");
        expect(reasons["claude"]).not.toBe("secrets");
        const lost = catalog.providers.find((entry) => entry.instance === "claude_work");
        expect(lost?.state._tag === "unavailable" && lost.state.message).toContain(
          "couldn't read its saved secrets",
        );
        expect(
          (yield* store.resolved).find((e) => e.config.id === "claude_work")?.environment,
        ).toEqual({});

        // Turning a default off still works and leaves the file alone; a secret save doesn't.
        yield* store.update({ ...defaultInstanceConfig("claude"), enabled: false });
        const refused = yield* store
          .update(
            work({
              environment: [
                { name: "MY_TOKEN", value: "new", sensitive: true, valueRedacted: false },
              ],
            }),
          )
          .pipe(Effect.flip);
        expect(refused.message).toContain(`${file}, where prkit keeps`);
        expect(yield* fs.readFileString(file)).toBe("{ not json");
      }),
    ));

  it("keeps ids unique whatever their case, defaults included", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        yield* store.create(work());
        for (const taken of ["Claude_Work", "CLAUDE_WORK", "Claude", "CODEX"]) {
          const refused = yield* store
            .create(work({ id: id(taken), kind: taken === "CODEX" ? "codex" : "claude" }))
            .pipe(Effect.flip);
          expect(refused.message, taken).toBe(`An instance named '${taken}' already exists.`);
        }
        const gone = yield* store.update(work({ id: id("Claude_Work") })).pipe(Effect.flip);
        expect(gone.message).toBe("That agent was removed. Check again.");
        expect((yield* store.resolved).map((entry) => entry.config.id)).toEqual([
          "claude",
          "codex",
          "cursor",
          "claude_work",
        ]);
      }),
    ));

  it("refuses names that would move an agent off its login or its sandbox", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const refused = yield* store
          .create(
            work({
              environment: [
                { name: "ANTHROPIC_API_KEY", value: "k", sensitive: true, valueRedacted: false },
              ],
            }),
          )
          .pipe(Effect.flip);
        expect(refused.message).toContain("off your subscription");
        expect((yield* store.resolved).map((entry) => entry.config.id)).toEqual([
          "claude",
          "codex",
          "cursor",
        ]);
      }),
    ));

  it("keeps a Cursor API key only as a Cursor agent's secret, and no config folder for Cursor", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const key = (sensitive: boolean) => ({
          name: "CURSOR_API_KEY",
          value: "key_123",
          sensitive,
          valueRedacted: false,
        });
        const cursor = (overrides: Partial<AgentInstanceConfig> = {}) =>
          work({ id: id("cursor_work"), kind: "cursor", configDir: null, ...overrides });
        const onClaude = yield* store.create(work({ environment: [key(true)] })).pipe(Effect.flip);
        expect(onClaude.message).toContain("Only a Cursor agent");
        const plain = yield* store.create(cursor({ environment: [key(false)] })).pipe(Effect.flip);
        expect(plain.message).toContain("Sensitive");
        const endpoint = yield* store
          .create(
            cursor({
              environment: [
                {
                  name: "CURSOR_BACKEND_URL",
                  value: "https://example.com",
                  sensitive: false,
                  valueRedacted: false,
                },
              ],
            }),
          )
          .pipe(Effect.flip);
        expect(endpoint.message).toContain("changes how Cursor runs");
        const folder = yield* store.create(cursor({ configDir: "~/.cursor" })).pipe(Effect.flip);
        expect(folder.message).toContain("leave Config folder and Binary path empty");

        yield* store.create(cursor({ environment: [key(true)] }));
        const read = (yield* store.resolved).find((entry) => entry.config.id === "cursor_work");
        expect(read?.environment).toEqual({ CURSOR_API_KEY: "key_123" });
        expect(read?.config.environment[0]?.value).toBe("");
        // A saved key can't be turned into a plain value later.
        const flipped = yield* store
          .update(cursor({ environment: [{ ...key(false), value: "key_456" }] }))
          .pipe(Effect.flip);
        expect(flipped.message).toContain("Sensitive");
        const kept = (yield* store.resolved).find((entry) => entry.config.id === "cursor_work");
        expect(kept?.environment).toEqual({ CURSOR_API_KEY: "key_123" });
      }),
    ));
});
