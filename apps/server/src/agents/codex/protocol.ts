import * as Schema from "effect/Schema";

export const AccountResponse = Schema.Struct({
  account: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("chatgpt"), planType: Schema.String }),
      Schema.Struct({ type: Schema.Literal("apiKey") }),
      Schema.Struct({ type: Schema.Literal("amazonBedrock") }),
    ]),
  ),
  requiresOpenaiAuth: Schema.Boolean,
});
/** `account/login/start` for a browser sign-in: the page to open, and the id its completion names. */
export const LoginStartResponse = Schema.Struct({
  type: Schema.Literal("chatgpt"),
  loginId: Schema.String,
  authUrl: Schema.String,
});
export const LoginCompleted = Schema.Struct({
  loginId: Schema.NullOr(Schema.String),
  success: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export const ThreadResponse = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
export const ThreadRuntimeResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  modelProvider: Schema.String,
  approvalPolicy: Schema.Literals(["never", "untrusted"]),
  sandbox: Schema.Struct({
    type: Schema.Literals(["readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox"]),
    networkAccess: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  }),
  activePermissionProfile: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  /** The instruction files Codex loaded for the thread, its home's AGENTS.md among them. */
  instructionSources: Schema.Array(Schema.String),
});
export const ConfigResponse = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
});
export const McpStatusResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      runtimeStatus: Schema.NullOr(Schema.String),
      tools: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String })),
      toolsError: Schema.NullOr(Schema.String),
    }),
  ),
});
export const TurnResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });
export const TurnCompleted = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["completed", "failed", "interrupted", "inProgress"]),
    error: Schema.NullOr(Schema.Struct({ message: Schema.String })),
  }),
});
export const MessageDelta = Schema.Struct({ threadId: Schema.String, delta: Schema.String });
/** What Codex parsed a shell command into (`commandActions` on a command item). */
export const ReadAction = Schema.Struct({ type: Schema.Literal("read"), path: Schema.String });
export const SearchAction = Schema.Struct({
  type: Schema.Literal("search"),
  command: Schema.String,
  query: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ListFilesAction = Schema.Struct({
  type: Schema.Literal("listFiles"),
  path: Schema.optional(Schema.NullOr(Schema.String)),
});
/** `unknown`, or an action type a later Codex adds. */
const OtherAction = Schema.Struct({ type: Schema.String, command: Schema.String });
export const CommandAction = Schema.Union([ReadAction, SearchAction, ListFilesAction, OtherAction]);
export type CommandAction = typeof CommandAction.Type;
export const ItemStarted = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("commandExecution"),
      id: Schema.String,
      command: Schema.String,
      commandActions: Schema.optional(Schema.Array(CommandAction)),
    }),
    Schema.Struct({
      type: Schema.Literal("mcpToolCall"),
      id: Schema.String,
      server: Schema.String,
      tool: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("fileChange"),
      id: Schema.String,
      changes: Schema.Array(Schema.Struct({ path: Schema.String })),
    }),
  ]),
});
/** A finished item; a command worked when it completed with exit code 0. */
export const ItemCompleted = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    status: Schema.optional(Schema.NullOr(Schema.String)),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
/** `model/list`: the models the signed-in account can use, page by page. */
export const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      displayName: Schema.String,
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      hidden: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      isDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      supportedReasoningEfforts: Schema.Array(
        Schema.Struct({
          reasoningEffort: Schema.String,
          description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
      defaultReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
      serviceTiers: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              description: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
      defaultServiceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CodexModel = (typeof ModelListResponse.Type)["data"][number];
