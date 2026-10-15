import type { AgentAccess, AgentEvent } from "../AgentProvider.ts";
import { QUIET_TOOLS, TOOL_LABELS } from "../AgentProvider.ts";
import type { FileRead } from "../commandReads.ts";
import { READ_FILE_TOOLS, WRITE_FILE_TOOLS } from "./fileTools.ts";
import type { Event } from "./protocol.ts";

/**
 * Cursor's own tools stay off: its read and edit tools reach files outside the checkout, whatever
 * its sandbox says. Cursor keeps only the two tools that list and call tools, which carry prkit's
 * own (fileTools.ts, prkitTools.ts) as the SDK's custom tools. The SDK sends the list to Cursor,
 * which offers nothing else.
 */
export const ALLOWED_TOOLS = ["mcp_tool_call", "get_mcp_tools_tool_call"];
/**
 * Every other tool SDK 1.0.37 names, refused as well (a refusal wins over the list above), so
 * no default of Cursor's can bring one back: files, shell, web, sub-agents, to-dos, MCP resources.
 */
export const DENIED_TOOLS = [
  "ai_attribution_tool_call",
  "apply_agent_diff_tool_call",
  "ask_question_tool_call",
  "await_tool_call",
  "blame_by_file_path_tool_call",
  "communicate_update_tool_call",
  "computer_use_tool_call",
  "connect_scm_tool_call",
  "create_agent_tool_call",
  "create_goal_tool_call",
  "create_plan_tool_call",
  "delete_tool_call",
  "edit_pr_labels_tool_call",
  "edit_tool_call",
  "fetch_cloud_agent_data_tool_call",
  "fetch_tool_call",
  "generate_image_tool_call",
  "generate_video_tool_call",
  "get_agent_status_tool_call",
  "glob_tool_call",
  "grep_tool_call",
  "list_mcp_resources_tool_call",
  "ls_tool_call",
  "mcp_auth_tool_call",
  "pi_bash_tool_call",
  "pi_edit_tool_call",
  "pi_find_tool_call",
  "pi_grep_tool_call",
  "pi_ls_tool_call",
  "pi_read_tool_call",
  "pi_write_tool_call",
  "pr_management_tool_call",
  "read_agent_transcript_tool_call",
  "read_canvas_tool_call",
  "read_lints_tool_call",
  "read_mcp_resource_tool_call",
  "read_todos_tool_call",
  "read_tool_call",
  "record_ci_investigation_findings_tool_call",
  "record_screen_tool_call",
  "reflect_tool_call",
  "replace_env_tool_call",
  "report_bug_tool_call",
  "report_bugfix_results_tool_call",
  "search_conversations_tool_call",
  "sem_search_tool_call",
  "send_final_summary_tool_call",
  "send_message_tool_call",
  "send_to_agent_tool_call",
  "send_to_user_tool_call",
  "set_active_branch_tool_call",
  "setup_vm_environment_tool_call",
  "shell_tool_call",
  "start_grind_execution_tool_call",
  "start_grind_planning_tool_call",
  "stop_agent_tool_call",
  "switch_mode_tool_call",
  "task_tool_call",
  "truncated_tool_call",
  "update_goal_tool_call",
  "update_todos_tool_call",
  "web_fetch_tool_call",
  "web_search_tool_call",
  "write_canvas_tool_call",
  "write_shell_stdin_tool_call",
  "x_search_tool_call",
];

/** The SDK's name for the server its custom tools appear under, prkit's tools among them. */
export const CUSTOM_TOOLS_SERVER = "custom-user-tools";

/** prkit's file tools for a turn: reading for a guide, and writing too for a fix. Never a command. */
export const fileToolsFor = (access: AgentAccess): ReadonlyArray<string> =>
  access._tag === "write" ? [...READ_FILE_TOOLS, ...WRITE_FILE_TOOLS] : READ_FILE_TOOLS;

const oneLine = (text: string, max: number) => text.replaceAll(/\s+/g, " ").trim().slice(0, max);

type ToolEvent = Extract<Event, { readonly type: "tool" }>;

/**
 * A tool call the runner reported, as prkit's activity log shows it: prkit's file tools by what
 * they did, prkit's MCP tools by their labels, and the ones whose effect the Guide tab shows not
 * at all. Cursor offers nothing else, so anything else is named as it came.
 */
export const describeToolCall = (
  call: ToolEvent,
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
    case "read_file":
      return call.path === null
        ? [tool("Read a file")]
        : [tool(`Read ${relative(call.path)}`, [{ path: call.path, lines: { _tag: "all" } }])];
    case "grep":
      return [tool(`Searched for ${oneLine(call.pattern ?? "", 60)}${where}`)];
    case "glob":
      return [tool(`Listed files matching ${oneLine(call.pattern ?? "", 60)}`)];
    case "list_dir":
      return [tool(call.path === null ? "Listed files" : `Listed files in ${relative(call.path)}`)];
    case "edit_file":
    case "write_file":
      return [tool(`Edited ${call.path === null ? "a file" : relative(call.path)}`)];
    case "prkit": {
      if (QUIET_TOOLS.has(call.name)) return [];
      const label = TOOL_LABELS[call.name];
      if (label === undefined) return [tool(`Used ${call.name}`)];
      return call.name === "submit_guide"
        ? [{ _tag: "composing-guide" }, tool(label)]
        : [tool(label)];
    }
    default:
      return [tool(`Used ${call.name}`)];
  }
};
