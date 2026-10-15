import * as Schema from "effect/Schema";

/**
 * Outside agents: the owner's own coding agent (Claude Code, Codex, anything that speaks
 * MCP) driving prkit through `$PRKIT_HOME/bin/prkit-mcp`. See docs/features/outside-agents.md.
 */

/** `read` lists and reads; `work` also opens PRs, starts guides and sends work to the fix agent. */
export const OutsideAccess = Schema.Literals(["read", "work"]);
export type OutsideAccess = typeof OutsideAccess.Type;

export const OutsideAgentsSettings = Schema.Struct({
  enabled: Schema.Boolean,
  access: OutsideAccess,
});
export type OutsideAgentsSettings = typeof OutsideAgentsSettings.Type;

export const OUTSIDE_AGENTS_DEFAULTS: OutsideAgentsSettings = { enabled: false, access: "read" };

/** One client seen since the last Reset access, by the name it gave in MCP `initialize`. */
export const OutsideClient = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  lastSeenAt: Schema.String,
});
export type OutsideClient = typeof OutsideClient.Type;

export const OutsideAgentsState = Schema.Struct({
  ...OutsideAgentsSettings.fields,
  clients: Schema.Array(OutsideClient),
  /** The launcher every client runs; it holds no secret. */
  launcher: Schema.String,
});
export type OutsideAgentsState = typeof OutsideAgentsState.Type;

export class OutsideAgentsError extends Schema.TaggedError<OutsideAgentsError>()(
  "OutsideAgentsError",
  { message: Schema.String },
) {}

/**
 * `$PRKIT_HOME/outside-agents.json`, mode 0600, removed when the server stops. `on` carries
 * the endpoint's port and token; `off` says prkit runs with the switch off, and holds neither.
 */
export const OutsideDiscovery = Schema.Union([
  Schema.TaggedStruct("on", {
    port: Schema.Int,
    token: Schema.String,
    pid: Schema.Int,
    version: Schema.String,
    access: OutsideAccess,
  }),
  Schema.TaggedStruct("off", { pid: Schema.Int, version: Schema.String }),
]);
export type OutsideDiscovery = typeof OutsideDiscovery.Type;
export const OutsideDiscoveryJson = Schema.fromJsonString(OutsideDiscovery);

export const OUTSIDE_DISCOVERY_FILE = "outside-agents.json";
export const OUTSIDE_LAUNCHER = "bin/prkit-mcp";
export const OUTSIDE_MCP_PATH = "/mcp/outside";
/** Carries the name the client gave in `initialize`, and the bridge's id, on every request. */
export const OUTSIDE_CLIENT_HEADER = "x-prkit-client";
export const OUTSIDE_BRIDGE_HEADER = "x-prkit-bridge";

const UNNAMED_CLIENT = "An outside agent";
/** Ids clients send in `initialize`, as people know them. */
const KNOWN_CLIENTS: Readonly<Record<string, string>> = { "claude-code": "Claude Code" };

/** A client's name as prkit shows it: printable, one line, at most 60 characters. */
export const cleanClientName = (name: string) => {
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned === "" ? UNNAMED_CLIENT : (KNOWN_CLIENTS[cleaned] ?? cleaned);
};

/** What a client hears when prkit can't answer, word for word. */
export const OUTSIDE_NOT_OPEN = "prkit isn't open. Open it, then try again.";
export const OUTSIDE_OFF =
  "Outside agents are off. Turn them on in prkit > Settings > Outside agents.";

/** The commands Settings > Outside agents offers to copy, for this home's launcher. */
export const outsideSetupCommands = (launcher: string) => {
  const quoted = /^[\w@%+=:,./-]+$/.test(launcher)
    ? launcher
    : `'${launcher.replace(/'/g, `'\\''`)}'`;
  return {
    claude: `claude mcp add --scope user prkit -- ${quoted}`,
    codex: `codex mcp add prkit -- ${quoted}`,
  };
};
