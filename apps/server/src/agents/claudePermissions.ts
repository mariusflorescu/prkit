import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PRKIT_TOOLS, type TurnSetup } from "./AgentProvider.ts";
import { decideTurnBash, fileArguments } from "./bashPolicy.ts";
import { type CheckoutPaths, MAX_LISTED } from "./checkoutPaths.ts";

/** prkit's MCP server is registered under this name, so its tools are `mcp__prkit__<tool>`. */
export const MCP_SERVER_NAME = "prkit";
export const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const PathInput = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const BashInput = Schema.Struct({
  command: Schema.String,
  run_in_background: Schema.optionalKey(Schema.Boolean),
});
export const decodePathInput = Schema.decodeUnknownOption(PathInput);
export const decodeBashInput = Schema.decodeUnknownOption(BashInput);

type ToolInput = Parameters<CanUseTool>[1];
const optional = Schema.optionalKey;
const strict = { onExcessProperty: "error" } as const;
/**
 * The folder each read tool reads, and for Glob the pattern under it, from its input as
 * Claude Code's SDK defines it (sdk-tools.d.ts); null for input with a field the tool
 * doesn't take, so no other field is judged in place of the one it reads.
 */
const READ_TOOLS: ReadonlyMap<
  string,
  (input: ToolInput) => { readonly folder?: string; readonly pattern?: string } | null
> = new Map([
  [
    "Read",
    (input: ToolInput) => {
      const value = Schema.decodeUnknownOption(
        Schema.Struct({
          file_path: Schema.String,
          offset: optional(Schema.Number),
          limit: optional(Schema.Number),
          pages: optional(Schema.String),
          allow_large: optional(Schema.Boolean),
        }),
        strict,
      )(input);
      return Option.isNone(value) ? null : { folder: value.value.file_path };
    },
  ],
  [
    "Grep",
    (input: ToolInput) => {
      const value = Schema.decodeUnknownOption(
        Schema.Struct({
          pattern: Schema.String,
          path: optional(Schema.String),
          glob: optional(Schema.String),
          output_mode: optional(Schema.Literals(["content", "files_with_matches", "count"])),
          "-B": optional(Schema.Number),
          "-A": optional(Schema.Number),
          "-C": optional(Schema.Number),
          context: optional(Schema.Number),
          "-n": optional(Schema.Boolean),
          "-i": optional(Schema.Boolean),
          "-o": optional(Schema.Boolean),
          type: optional(Schema.String),
          head_limit: optional(Schema.Number),
          offset: optional(Schema.Number),
          multiline: optional(Schema.Boolean),
        }),
        strict,
      )(input);
      if (Option.isNone(value)) return null;
      return value.value.path === undefined ? {} : { folder: value.value.path };
    },
  ],
  [
    "Glob",
    (input: ToolInput) => {
      const value = Schema.decodeUnknownOption(
        Schema.Struct({ pattern: Schema.String, path: optional(Schema.String) }),
        strict,
      )(input);
      if (Option.isNone(value)) return null;
      const { pattern, path } = value.value;
      return path === undefined ? { pattern } : { folder: path, pattern };
    },
  ],
]);

const allow = (toolInput: Parameters<CanUseTool>[1]): PermissionResult => ({
  behavior: "allow",
  updatedInput: toolInput,
});
const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

/**
 * What one Claude turn may do (docs/internals/architecture.md "Agents",
 * docs/internals/fix-agent.md "What the agent may do"): the tools it has and which
 * calls run. A guide turn reads; a fix turn also edits files under its checkout and,
 * on a trusted pull request, runs the repository's check scripts, inside the sandbox
 * of `claudeSandbox.ts`. Every path is judged where it really lands, links resolved.
 */
export const claudePermissions = (input: TurnSetup, paths: CheckoutPaths) => {
  const writes = input.access._tag === "write";
  const ownTools = new Set(input.tools.map((tool) => `${MCP_PREFIX}${tool}`));
  /** The answer to a call whose paths were judged, naming the first that reaches outside. */
  const readsInside = (toolInput: Parameters<CanUseTool>[1], outside: string | null) =>
    outside === null
      ? allow(toolInput)
      : deny(
          `\`${outside}\` can reach outside the pull request's checkout. Only the checkout can be read, a link in it can't lead outside, a pattern can't match a file named like an option, and a pattern can't cover more than ${MAX_LISTED.toLocaleString("en-US")} files and folders. Use paths inside the working directory.`,
        );

  const decide = (
    toolName: string,
    toolInput: Parameters<CanUseTool>[1],
  ): Effect.Effect<PermissionResult> => {
    if (toolName.startsWith(MCP_PREFIX))
      return Effect.succeed(
        ownTools.has(toolName) ? allow(toolInput) : deny(`${toolName} isn't part of this turn.`),
      );
    if (toolName === "Bash") {
      const bash = decodeBashInput(toolInput);
      if (Option.isNone(bash)) return Effect.succeed(deny("The Bash call had no command."));
      if (bash.value.run_in_background === true)
        return Effect.succeed(
          deny("Background commands aren't allowed. Run it in the foreground."),
        );
      const decision = decideTurnBash(bash.value.command, input.access);
      if (!decision.allow) return Effect.succeed(deny(decision.reason));
      return paths
        .unreadable(fileArguments(bash.value.command))
        .pipe(Effect.map((outside) => readsInside(toolInput, outside)));
    }
    const readTool = READ_TOOLS.get(toolName);
    if (readTool !== undefined) {
      const reads = readTool(toolInput);
      if (reads === null)
        return Effect.succeed(deny(`prkit couldn't check the paths of this ${toolName} call.`));
      // Glob's pattern is a path too, under its folder: `/Users/*/.ssh/*` lists files outside.
      const { folder, pattern } = reads;
      const argument = (target: string | undefined) =>
        target === undefined ? [] : [{ path: target, option: false }];
      return Effect.all([
        paths.unreadable(argument(folder)),
        paths.unreadable(argument(pattern), folder),
      ]).pipe(Effect.map(([outside, matched]) => readsInside(toolInput, outside ?? matched)));
    }
    if ((toolName === "Edit" || toolName === "Write") && writes) {
      const target = decodePathInput(toolInput).pipe(
        Option.flatMap((value) => Option.fromNullishOr(value.file_path)),
      );
      const refused = deny(
        "Only files in the pull request's checkout can change, never through a link and never .git. Use paths inside the working directory.",
      );
      return Option.isNone(target)
        ? Effect.succeed(refused)
        : paths
            .writable([target.value])
            .pipe(Effect.map((inside) => (inside ? allow(toolInput) : refused)));
    }
    return Effect.succeed(
      deny(
        writes
          ? `${toolName} isn't available to prkit's agent.`
          : `${toolName} isn't available to prkit's read-only agent.`,
      ),
    );
  };

  const tools = writes
    ? (["Read", "Grep", "Glob", "Bash", "Edit", "Write"] as const)
    : (["Read", "Grep", "Glob", "Bash"] as const);
  return {
    decide,
    tools,
    // prkit's other turns' tools stay out of sight, not just refused.
    disallowedTools: PRKIT_TOOLS.filter((tool) => !input.tools.includes(tool)).map(
      (tool) => `${MCP_PREFIX}${tool}`,
    ),
    /**
     * Claude Code approves reads inside the working directory and commands it thinks
     * are read-only on its own; `ask` sends every call of these to canUseTool.
     */
    ask: tools,
  };
};
