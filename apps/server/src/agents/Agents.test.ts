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

const Harness = Layer.effect(Agents.Agents, Agents.make).pipe(
  Layer.provideMerge(AgentInstancesStore.layer),
  Layer.provideMerge(Config),
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const run = <A, E>(test: Effect.Effect<A, E, Layer.Success<typeof Harness>>) =>
  Effect.runPromise(
    test.pipe(Effect.provide(Harness), Effect.provideService(References.MinimumLogLevel, "Error")),
  );

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
        yield* store.create({
          ...defaultInstanceConfig("codex"),
          id: id("codex_side"),
          label: "Side",
        });
        const folder = `${home}/codex-instances/codex_side`;
        yield* fs.makeDirectory(folder, { recursive: true });

        yield* agents.remove(id("codex_side"));
        expect(yield* fs.exists(folder)).toBe(false);
        expect(yield* agents.get(id("codex_side"))).toBeNull();

        const refused = yield* agents.remove(id("codex")).pipe(Effect.flip);
        expect(refused.message).toContain("can't be removed");
      }),
    ));
});

describe("setupOf", () => {
  const resolved = (config: AgentInstanceConfig) => ({ config, environment: {} });

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
        ]);
      }),
    ));
});
