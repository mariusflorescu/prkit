import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AccountId,
  AgentInstanceId,
  defaultInstanceConfig,
  FixerId,
  PullRequestKey,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { describe, expect, it } from "vite-plus/test";

import * as AgentInstancesStore from "../agents/AgentInstances.ts";
import * as Agents from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as GuideSettingsStore from "../reviews/GuideSettingsStore.ts";
import { makeAgentChoice } from "./agentChoice.ts";
import type { FixerRow } from "./fixerRows.ts";

const Config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "prkit-agent-choice-",
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

/** Neither agent can start: a session that needs the default agent finds none ready. */
const NoAgents = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "prkit-fake-agents-" });
    yield* fs.writeFileString(`${folder}/agent`, "#!/bin/sh\nexit 1\n");
    yield* fs.chmod(`${folder}/agent`, 0o755);
    process.env.PRKIT_CLAUDE_PATH = `${folder}/agent`;
    process.env.PRKIT_CODEX_PATH = `${folder}/agent`;
  }),
);

const Harness = Layer.effect(Agents.Agents, Agents.make).pipe(
  Layer.provideMerge(GuideSettingsStore.layer),
  Layer.provideMerge(AgentInstancesStore.layer),
  Layer.provideMerge(Config),
  Layer.provideMerge(NoAgents),
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

/** A fix session on the second Claude, as a redo, a revert or a change request finds it. */
const session: FixerRow = {
  id: FixerId.make("fixer-1"),
  pr_key: PullRequestKey.make("github.com/acme/widgets#1"),
  account_id: AccountId.make("github.com/octocat"),
  provider: "claude",
  instance_id: AgentInstanceId.make("claude_work"),
  model: "claude-sonnet-5-5",
  model_options: [],
  session_id: "session-1",
  ended: null,
  created_at: "2026-10-11T00:00:00.000Z",
  updated_at: "2026-10-11T00:00:00.000Z",
};

describe("chooseAgent for a turn nobody picked an agent for", () => {
  it("keeps the session's instance, falls back to its kind's default, then to the default agent", () =>
    run(
      Effect.gen(function* () {
        const store = yield* AgentInstancesStore.AgentInstances;
        const { chooseAgent } = yield* makeAgentChoice;
        yield* store.create({
          ...defaultInstanceConfig("claude"),
          id: AgentInstanceId.make("claude_work"),
          label: "Work",
        });
        expect((yield* chooseAgent(undefined, session)).instance).toBe("claude_work");

        // The second Claude is off: the redo runs on the default Claude, same model.
        yield* store.update({
          ...defaultInstanceConfig("claude"),
          id: AgentInstanceId.make("claude_work"),
          label: "Work",
          enabled: false,
        });
        expect(yield* chooseAgent(undefined, session)).toEqual({
          instance: "claude",
          provider: "claude",
          model: "claude-sonnet-5-5",
          options: [],
        });

        // The default Claude is off too: the default agent, and here none is ready.
        yield* store.update({ ...defaultInstanceConfig("claude"), enabled: false });
        const none = yield* chooseAgent(undefined, session).pipe(Effect.flip);
        expect(none.message).toBe(
          "No agent is ready. Sign one in under Settings > Agents, then check again.",
        );
      }),
    ));
});
