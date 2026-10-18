import type {
  AgentInstanceId,
  AgentModel,
  AgentProviderKind,
  AgentProviderState,
  AgentSignInPage,
  ModelOptionSelection,
} from "@prkit/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { Checkout } from "../repo/gitRun.ts";
import type { ScriptRuns } from "./bashPolicy.ts";
import type { FileRead } from "./commandReads.ts";
import type { AgentTurn } from "./turnEnd.ts";

/** prkit's MCP tools for a guide turn, as the agent sees them. */
export const GUIDE_TOOLS = [
  "submit_guide",
  "revise_guide",
  "submit_draft",
  "note_file",
  "report_progress",
] as const;
/** prkit's MCP tools for a fix turn. */
export const FIX_TOOLS = ["finish_fixes", "finish_conflicts", "report_progress"] as const;
/** An Ask turn answers in its reply. prkit's MCP server still connects, and refuses every tool. */
export const ASK_TOOLS = [] as const;
export const PRKIT_TOOLS: ReadonlyArray<string> = [...new Set([...GUIDE_TOOLS, ...FIX_TOOLS])];
/** What the end-of-turn tools are called in the activity log. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  submit_guide: "Submitted the guide",
  revise_guide: "Revised the guide",
  finish_fixes: "Reported the fixes",
  finish_conflicts: "Reported the resolution",
};

/**
 * What a turn may do besides reading. A guide turn is read-only; a fix turn edits
 * files under `cwd` and, on a trusted pull request, runs the repository's own check
 * scripts by name, with the network off wherever the provider's sandbox can do that.
 * Either way its commands keep their temporary files in `tmpDir`, which prkit removes.
 */
export type AgentAccess =
  | { readonly _tag: "read-only"; readonly tmpDir: string }
  | { readonly _tag: "write"; readonly scripts: ScriptRuns; readonly tmpDir: string };
/** Tools whose effect shows in the Guide tab itself, so they stay out of the activity log. */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  "submit_draft",
  "note_file",
  "report_progress",
]);

/** What one agent turn reports, in order. The stream ends only after the agent's process has exited. */
export type AgentEvent =
  /** The agent's process group leader, so a crashed server's successor can stop it. */
  | { readonly _tag: "process"; readonly pid: number }
  | { readonly _tag: "session"; readonly sessionId: string }
  /** prkit's MCP server is connected; a turn without it fails before doing any work. */
  | { readonly _tag: "mcp-ready" }
  /** A tool call started. `detail` is the raw call; `reads` are the files it prints. */
  | {
      readonly _tag: "tool";
      readonly id: string;
      readonly label: string;
      readonly detail: string | null;
      readonly reads: ReadonlyArray<FileRead>;
    }
  /** A tool call returned; its reads count only when it worked. */
  | { readonly _tag: "tool-done"; readonly id: string; readonly ok: boolean }
  /** The agent started writing a `submit_guide` call (the "writing-guide" phase). */
  | { readonly _tag: "composing-guide" }
  /** More of that call's input, as JSON text, while the agent is still writing it. */
  | { readonly _tag: "guide-input"; readonly id: string; readonly json: string }
  /** More of the agent's reply, as it writes it. */
  | { readonly _tag: "text"; readonly delta: string }
  | {
      readonly _tag: "finished";
      readonly outcome: "completed" | "failed" | "interrupted";
      readonly message: string | null;
    };

/** A turn whose agent instance was turned off or removed after it was queued. */
export const AGENT_OFF =
  "This pull request's agent is turned off or was removed. Pick another agent and retry.";

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  /** `auth` means the agent isn't installed, isn't logged in, or isn't on a subscription. */
  reason: Schema.Literals(["auth", "agent"]),
  message: Schema.String,
}) {}

export interface TurnInput {
  /**
   * The turn's id, which the processes it starts inherit as `PRKIT_TURN`, and where prkit
   * reports whether what it could tie to the turn has ended (docs/internals/fix-agent.md "Turn end").
   */
  readonly turn: AgentTurn;
  /** The checkout the agent works in: the review's at the head SHA, or the fixer's. */
  readonly cwd: string;
  /** The checkout's git-dir layout, computed by prkit, so the sandbox denies its git data by prkit's paths, not the checkout's. */
  readonly checkout: Checkout;
  /** Directories the agent may read besides `cwd`. */
  readonly readableDirs: ReadonlyArray<string>;
  /** The rules for this kind of turn (guide writing or fixing). */
  readonly instructions: string;
  /** This turn's task. */
  readonly prompt: string;
  readonly resumeSessionId: string | null;
  /** Null runs the agent's own default model. */
  readonly model: string | null;
  readonly options: ReadonlyArray<ModelOptionSelection>;
  readonly mcp: { readonly url: string; readonly bearerToken: string };
  /** Extra environment for the agent's own commands (prkit's isolated git config). */
  readonly env: Readonly<Record<string, string>>;
  readonly access: AgentAccess;
  /** prkit's MCP tools this turn may call. */
  readonly tools: ReadonlyArray<string>;
}

/** Everything a turn runs with but how it starts its conversation. */
export type TurnSetup = Omit<TurnInput, "resumeSessionId">;

/** A turn in a new copy of saved conversation `forkFrom`, which is only read, never added to. */
export interface ForkTurnInput extends TurnSetup {
  readonly forkFrom: string;
}

/** How a provider's turn starts its conversation: `runTurn` starts one or resumes it, `forkTurn` forks it. */
export type TurnStart =
  | { readonly _tag: "new" }
  | { readonly _tag: "resume"; readonly id: string }
  | { readonly _tag: "fork"; readonly from: string };

export const startOf = (input: TurnInput): TurnStart =>
  input.resumeSessionId === null ? { _tag: "new" } : { _tag: "resume", id: input.resumeSessionId };

/** What one instance runs with, resolved by `Agents` from its settings. */
export interface InstanceSetup {
  readonly id: AgentInstanceId;
  readonly label: string;
  readonly isDefault: boolean;
  /** CLAUDE_CONFIG_DIR or the user's CODEX_HOME, `~` expanded; null for the agent's own default. */
  readonly configDir: string | null;
  /** `~` expanded; null finds the agent on PATH. */
  readonly binaryPath: string | null;
  /** The instance's own variables, already checked against the names prkit refuses. */
  readonly environment: Readonly<Record<string, string>>;
  /** Codex: prkit holds this instance's own ChatGPT login instead of sharing the config folder's. */
  readonly login: "shared" | "prkit";
}

export interface AgentProvider {
  readonly instance: AgentInstanceId;
  readonly kind: AgentProviderKind;
  readonly label: string;
  /** Instances with the same group share conversations (the folder the agent keeps sessions in). */
  readonly group: string;
  /** The installed agent's version, looked up again on every call. */
  readonly version: Effect.Effect<string | null>;
  /** Before the instance is removed: signs out any login prkit holds for it and deletes its files. */
  readonly retire: Effect.Effect<void, AgentError>;
  /**
   * Reports `submit_guide`'s input while the agent writes it (`guide-input`), so the
   * agent writes the guide once and prkit shows it as it grows. Without it, the
   * agent shares the guide early through `submit_draft` calls first.
   */
  readonly streamsGuideInput: boolean;
  /** Installed and logged in with a subscription, checked without starting a turn. */
  readonly check: Effect.Effect<AgentProviderState>;
  /** The models this login can use, with the settings each one takes. */
  readonly models: (state: AgentProviderState) => Effect.Effect<ReadonlyArray<AgentModel>>;
  /** Whether a saved session can still be resumed from `cwd`. */
  readonly hasSession: (sessionId: string, cwd: string) => Effect.Effect<boolean>;
  /** One turn. The process lives exactly as long as the returned stream's scope. */
  readonly runTurn: (input: TurnInput) => Stream.Stream<AgentEvent, AgentError>;
  /**
   * One turn in a fork of a saved conversation, contained exactly as `runTurn` contains the
   * same `access` and `tools`. Its `session` event names the fork. Null where the agent
   * can't fork a conversation, so a fork only ever goes through an agent that can.
   */
  readonly forkTurn: ((input: ForkTurnInput) => Stream.Stream<AgentEvent, AgentError>) | null;
  /** prkit's own login, for when the user's can't be shared. Null when the user's always can. */
  readonly ownLogin: {
    /** The sign-in page, then the end of the stream once signed in; stopping it cancels. */
    readonly signIn: Stream.Stream<AgentSignInPage, AgentError>;
    readonly signOut: Effect.Effect<void, AgentError>;
  } | null;
}
