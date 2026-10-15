import * as Schema from "effect/Schema";

/**
 * What prkit and its Cursor runner say to each other. The runner is a child process prkit starts
 * for each check, sign-in or turn: one request line on its stdin, then event lines on its stdout
 * until it exits. Secrets (the API key, prkit's MCP token) travel only in the request, never in
 * the runner's arguments or environment.
 */

const Common = {
  /** The SDK's package folder (sdkLoader.ts). */
  sdk: Schema.String,
  /** The instance's own CURSOR_API_KEY; null uses the key its sign-in saved. */
  apiKey: Schema.NullOr(Schema.String),
};

export const TurnRequest = Schema.Struct({
  ...Common,
  op: Schema.Literal("turn"),
  cwd: Schema.String,
  readableDirs: Schema.Array(Schema.String),
  /** The turn's rules and its task, in one message: Cursor takes no system prompt from prkit. */
  message: Schema.String,
  resumeSessionId: Schema.NullOr(Schema.String),
  /** Null runs Cursor's own pick, as the catalog shows it (models.ts). */
  model: Schema.NullOr(Schema.String),
  params: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
  /** prkit's file tools Cursor gets (fileTools.ts); none of Cursor's own (tools.ts). */
  fileTools: Schema.Array(Schema.String),
  /** prkit's MCP server and the tools of it this turn may call, through the runner (prkitTools.ts). */
  mcp: Schema.Struct({
    url: Schema.String,
    token: Schema.String,
    tools: Schema.Array(Schema.String),
  }),
});
export type TurnRequest = typeof TurnRequest.Type;

export const Request = Schema.Union([
  Schema.Struct({ ...Common, op: Schema.Literals(["status", "models", "login", "logout"]) }),
  Schema.Struct({
    ...Common,
    op: Schema.Literal("has-session"),
    sessionId: Schema.String,
    cwd: Schema.String,
  }),
  TurnRequest,
]);
export type Request = typeof Request.Type;

export const RunnerModel = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        displayName: Schema.optionalKey(Schema.String),
        values: Schema.Array(
          Schema.Struct({ value: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
  ),
  /** Named settings combinations; the default one gives each setting's default value. */
  variants: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        params: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
        isDefault: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export type RunnerModel = typeof RunnerModel.Type;

/**
 * What starts each event line the runner writes. The SDK may print to stdout too, even half a
 * line with no newline; prkit reads an event from its last mark on a line, so stray output
 * before it can't swallow it.
 */
export const EVENT_MARK = "\u001eprkit-event:";

/** The event a line carries, read from its last mark; null when it has none. */
export const eventText = (line: string) => {
  const at = line.lastIndexOf(EVENT_MARK);
  return at === -1 ? null : line.slice(at + EVENT_MARK.length);
};

export const Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    /** `login`: the key prkit's sign-in saved; `key`: the instance's CURSOR_API_KEY. */
    via: Schema.NullOr(Schema.Literals(["login", "key"])),
    /** When the saved key stops working, for a sign-in; null otherwise. */
    expiresAtMs: Schema.NullOr(Schema.Number),
    /** Cursor turned the key down (expired, revoked or wrong). */
    rejected: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("models"), models: Schema.Array(RunnerModel) }),
  Schema.Struct({ type: Schema.Literal("login-url"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("signed-in") }),
  Schema.Struct({ type: Schema.Literal("signed-out"), confirmed: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("has-session"), found: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("session"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    callId: Schema.String,
    /**
     * One of prkit's file tools (read_file, grep...), `prkit` for its MCP tools, `mcp` for a tool
     * of a server Cursor doesn't have, else `other`: one of Cursor's own.
     */
    tool: Schema.String,
    /** The tool's own name: submit_guide for a `prkit` call. */
    name: Schema.String,
    /** The file or folder the call works on, when it names one, resolved against the checkout. */
    path: Schema.NullOr(Schema.String),
    /** The search pattern, for grep and glob. */
    pattern: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("tool-done"), callId: Schema.String, ok: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("finished"),
    outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    message: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: Schema.Literals(["auth", "agent"]),
    message: Schema.String,
  }),
]);
export type Event = typeof Event.Type;
