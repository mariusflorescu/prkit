import type { AgentAccess, AgentEvent } from "../AgentProvider.ts";
import { QUIET_TOOLS, TOOL_LABELS } from "../AgentProvider.ts";
import type { FileRead } from "../commandReads.ts";
import type { Event } from "./protocol.ts";

/**
 * Cursor's built-in tools a guide may use: reading, searching, its own to-do list, and MCP for
 * prkit's tools. The SDK approves every request a tool makes on its own, with nobody to ask, so
 * a tool is either safe to run unasked or absent. Shell and task never are: a command would run
 * outside prkit's rules, and a sub-agent keeps its own tools.
 */
export const GUIDE_TOOL_SET = ["read", "grep", "glob", "ls", "mcp", "updateTodos", "readTodos"];
/** A fix edits files too, and only that: Cursor never runs the repository's scripts. */
export const FIX_TOOL_SET = [...GUIDE_TOOL_SET, "edit"];
/** Removed as well, so a tool set that grew by mistake still can't offer them (deny wins). */
export const NEVER_TOOLS = ["shell", "task"];

export const toolSetFor = (access: AgentAccess) =>
  access._tag === "write" ? FIX_TOOL_SET : GUIDE_TOOL_SET;

/** Why a Cursor fix runs no scripts, as the Fixes header and Repository settings say it. */
export const CURSOR_SCRIPTS_REASON =
  "Cursor fixes edit files only: Cursor can't ask before each command, so it never runs this repository's scripts.";

const oneLine = (text: string, max: number) => text.replaceAll(/\s+/g, " ").trim().slice(0, max);

type ToolEvent = Extract<Event, { readonly type: "tool" }>;

/**
 * A tool call the runner reported, as prkit's activity log shows it. prkit's own MCP tools are
 * known by the turn's server name; ones whose effect the Guide tab shows stay out of the log.
 */
export const describeToolCall = (
  call: ToolEvent,
  prkitServer: string,
  relative: (path: string) => string,
): ReadonlyArray<AgentEvent> => {
  const tool = (label: string, reads: ReadonlyArray<FileRead> = []): AgentEvent => ({
    _tag: "tool",
    id: call.callId,
    label,
    detail: null,
    reads,
  });
  const where = call.path === null ? "" : ` in ${relative(call.path)}`;
  switch (call.tool) {
    case "read":
      return call.path === null
        ? [tool("Read a file")]
        : [tool(`Read ${relative(call.path)}`, [{ path: call.path, lines: { _tag: "all" } }])];
    case "grep":
      return [tool(`Searched for ${oneLine(call.pattern ?? "", 60)}${where}`)];
    case "glob":
      return [tool(`Listed files matching ${oneLine(call.pattern ?? "", 60)}`)];
    case "ls":
      return [tool(call.path === null ? "Listed files" : `Listed files in ${relative(call.path)}`)];
    case "edit":
    case "write":
      return [tool(`Edited ${call.path === null ? "a file" : relative(call.path)}`)];
    case "updateTodos":
    case "readTodos":
      return [];
    case "mcp": {
      if (call.mcp === null) return [tool("Used an MCP tool")];
      if (call.mcp.server !== prkitServer) return [tool(`Used ${call.mcp.tool}`)];
      if (QUIET_TOOLS.has(call.mcp.tool)) return [];
      const label = TOOL_LABELS[call.mcp.tool];
      if (label === undefined) return [tool(`Used ${call.mcp.tool}`)];
      return call.mcp.tool === "submit_guide"
        ? [{ _tag: "composing-guide" }, tool(label)]
        : [tool(label)];
    }
    default:
      return [tool(`Used ${call.tool}`)];
  }
};
