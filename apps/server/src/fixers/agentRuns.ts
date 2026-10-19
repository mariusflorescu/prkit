import {
  type FixerTurnId,
  explicitModelOptions,
  findAgentModel,
  type PullRequestKey,
  type TurnScripts,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { type AgentProvider, FIX_TOOLS } from "../agents/AgentProvider.ts";
import { processStartTime } from "../agents/agentProcess.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import type { TurnEnd } from "../agents/turnEnd.ts";
import { Agents } from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { boundPort } from "../listenAddress.ts";
import { McpTokens } from "../mcp/McpTokens.ts";
import { type Checkout, RepoCache } from "../repo/RepoCache.ts";
import type { FixerRow } from "./fixerRows.ts";
import type { Awaiting, FixerState } from "./fixerState.ts";
import { nudgePrompt } from "./prompt.ts";
import { scriptRuns } from "./scriptAccess.ts";
import { type TurnLeftovers, unfinishedMessage } from "./turnLeftovers.ts";

/**
 * Runs the agent for a turn: one process per call with a fresh MCP token, resuming
 * the session's conversation, until the agent has sent the report the turn owes.
 */
export const makeAgentRuns = (state: FixerState, leftovers: TurnLeftovers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* RepoCache;
    const agents = yield* Agents;
    const tokens = yield* McpTokens;
    const server = yield* HttpServer.HttpServer;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { appendActivity, awaiting, contextDir, fail, fixerById } = state;

    const mcpUrl = `http://${config.host}:${Option.getOrElse(boundPort(server.address), () => config.port)}/mcp`;
    const instructions = yield* fs.readFileString(
      path.join(
        path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
        "fix-instructions.md",
      ),
    );

    /** The session to resume, if the provider still has it for this checkout. */
    const resumeFor = (
      key: PullRequestKey,
      turnId: FixerTurnId,
      fixer: FixerRow,
      provider: AgentProvider,
      worktree: string,
    ) =>
      Effect.gen(function* () {
        if (fixer.session_id === null) return null;
        if (yield* provider.hasSession(fixer.session_id, worktree)) return fixer.session_id;
        yield* appendActivity(
          key,
          turnId,
          "note",
          `${provider.label} no longer has this pull request's earlier conversation, so this starts a new one`,
        );
        return null;
      });

    /** One agent turn with a fresh bearer token, revoked when the turn's process is gone. */
    const agentTurn = (
      fixer: FixerRow,
      turnId: FixerTurnId,
      input: {
        readonly provider: AgentProvider;
        readonly cwd: string;
        readonly checkout: Checkout;
        readonly prompt: string;
        readonly resume: string | null;
        readonly scripts: TurnScripts;
      },
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const token = yield* tokens.issue({ _tag: "fixer", turnId, fixerId: fixer.id });
          const catalog = yield* agents.catalog();
          const current = (yield* fixerById(fixer.id)) ?? fixer;
          const model = findAgentModel(catalog, current.instance_id, current.model);
          // Every setting goes in explicitly, so a resumed session doesn't keep an older choice.
          const options = explicitModelOptions(model, current.model_options);
          // Removed with the turn's context when its run ends, or on the next start after a
          // crash. The context comes first, so a start after a crash finds the temp folder.
          const context = path.join(contextDir, turnId);
          const tmpDir = turnTmpDir(path, turnId);
          yield* fs.makeDirectory(context, { recursive: true });
          yield* fs.remove(tmpDir, { recursive: true, force: true });
          yield* fs.makeDirectory(tmpDir, { mode: 0o700 });
          const result: {
            sessionId: string | null;
            finished: { readonly outcome: string; readonly message: string | null } | null;
          } = { sessionId: input.resume, finished: null };
          // How the turn ended, once the agent reports it. An unfinished end is saved at once,
          // so a Stop, a Retry or a restart finds it before any of prkit's git.
          const ended = yield* Ref.make<TurnEnd | null>(null);
          const report = (end: TurnEnd) =>
            Ref.set(ended, end).pipe(
              Effect.andThen(
                end._tag === "unfinished"
                  ? leftovers
                      .record(turnId, end)
                      .pipe(
                        Effect.catchTag("SqlError", (error) =>
                          Effect.logError("Couldn't save how the agent turn ended", error),
                        ),
                      )
                  : Effect.void,
              ),
            );
          // prkit's git comes next, so nothing the turn started may still be running.
          const stopUnlessEnded = (end: TurnEnd | null) =>
            end?._tag === "unfinished"
              ? fail("checks", unfinishedMessage(end.reason))
              : Effect.void;
          yield* input.provider
            .runTurn({
              turn: { id: turnId, ended: report },
              cwd: input.cwd,
              checkout: input.checkout,
              readableDirs: [context],
              instructions,
              prompt: input.prompt,
              resumeSessionId: input.resume,
              model: current.model,
              options,
              mcp: { url: mcpUrl, bearerToken: Redacted.value(token) },
              env: repo.isolatedGitEnv,
              access: { _tag: "write", scripts: scriptRuns(input.scripts), tmpDir },
              tools: FIX_TOOLS,
            })
            .pipe(
              Stream.runForEach((event) => {
                switch (event._tag) {
                  case "process":
                    return processStartTime(event.pid).pipe(
                      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                      Effect.flatMap(
                        (started) => sql`UPDATE fixer_turns SET agent_pid = ${event.pid},
                          agent_started = ${started} WHERE id = ${turnId}`,
                      ),
                      Effect.asVoid,
                    );
                  case "session":
                    result.sessionId = event.sessionId;
                    // Saved the moment it is known, so a crash mid-turn still leaves it resumable.
                    return sql`UPDATE fixers SET session_id = ${event.sessionId} WHERE id = ${fixer.id}`.pipe(
                      Effect.asVoid,
                    );
                  case "tool":
                    return appendActivity(fixer.pr_key, turnId, "tool", event.label, event.detail);
                  case "finished":
                    result.finished = { outcome: event.outcome, message: event.message };
                    return Effect.logInfo("Fix turn finished").pipe(
                      Effect.annotateLogs({ outcome: event.outcome }),
                    );
                  case "tool-done":
                  case "composing-guide":
                  case "guide-input":
                  case "mcp-ready":
                  case "text":
                    return Effect.void;
                }
              }),
              Effect.catchTag("AgentError", (error) =>
                (error.reason === "auth" ? agents.invalidate : Effect.void).pipe(
                  // An agent that failed before its process started has nothing to end.
                  Effect.andThen(Ref.get(ended)),
                  Effect.flatMap(stopUnlessEnded),
                  Effect.andThen(
                    fail(error.reason === "auth" ? "agent-auth" : "agent", error.message),
                  ),
                ),
              ),
            );
          // A turn that ran to the end must have reported how it ended.
          yield* stopUnlessEnded(
            (yield* Ref.get(ended)) ?? {
              _tag: "unfinished",
              reason: "the turn's end wasn't reported",
              processes: [],
            },
          );
          return result;
        }),
      );

    /**
     * Runs the agent until it has sent the report this turn owes, nudging once.
     * Fails with `no-report` when it ends twice without one.
     */
    const untilReported = (
      fixer: FixerRow,
      turnId: FixerTurnId,
      expected: Awaiting,
      input: Parameters<typeof agentTurn>[2],
    ) =>
      Effect.gen(function* () {
        awaiting.set(turnId, expected);
        const first = yield* agentTurn(fixer, turnId, input);
        if (!awaiting.has(turnId)) return;
        if (first.finished?.outcome !== "completed" || first.sessionId === null)
          return yield* fail(
            "agent",
            first.finished?.message ?? `${input.provider.label} stopped before reporting.`,
          );
        yield* appendActivity(
          fixer.pr_key,
          turnId,
          "note",
          "The agent ended without a report prkit could accept. Asking once more",
        );
        yield* agentTurn(fixer, turnId, {
          ...input,
          prompt: nudgePrompt(expected._tag),
          resume: first.sessionId,
        });
        if (awaiting.has(turnId))
          return yield* fail(
            "no-report",
            `${input.provider.label} finished twice without a report prkit could accept. Retry to start over.`,
          );
      }).pipe(Effect.ensuring(Effect.sync(() => awaiting.delete(turnId))));

    return { resumeFor, untilReported };
  });

export type AgentRuns = Effect.Success<ReturnType<typeof makeAgentRuns>>;
