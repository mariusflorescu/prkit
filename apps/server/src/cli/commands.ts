import { makeOutsideToolkit } from "../mcp/outside/tools.ts";
import * as SchemaAST from "effect/SchemaAST";

export const toolkit = makeOutsideToolkit(() => true);
export type ToolName = keyof typeof toolkit.tools;

export type CommandMapping = {
  readonly path: readonly [string, ...string[]];
  /** `local` takes `--key` or `--path`, and without either the working directory. */
  readonly target?: "pr" | "repository" | "local";
};

export const commandMap = {
  prkit_status: { path: ["status"] },
  list_inbox: { path: ["inbox"] },
  list_open_pull_requests: { path: ["tabs", "list"] },
  read_pull_request: { path: ["pr", "read"], target: "pr" },
  open_pull_request: { path: ["pr", "open"], target: "pr" },
  read_guide: { path: ["guide", "read"], target: "pr" },
  generate_guide: { path: ["guide", "generate"], target: "pr" },
  stop_guide: { path: ["guide", "stop"], target: "pr" },
  list_review_comments: { path: ["comments", "list"], target: "pr" },
  add_review_comment: { path: ["comments", "add"], target: "pr" },
  read_fix: { path: ["fix", "read"], target: "pr" },
  send_to_fix_agent: { path: ["fix", "send"], target: "pr" },
  ask_fix_agent_to_change: { path: ["fix", "change"], target: "pr" },
  stop_fix: { path: ["fix", "stop"], target: "pr" },
  retry_fix: { path: ["fix", "retry"], target: "pr" },
  resolve_conflicts: { path: ["fix", "resolve"], target: "pr" },
  wait_for: { path: ["wait"], target: "pr" },
  list_accounts: { path: ["accounts"] },
  list_repositories: { path: ["repos", "list"] },
  list_repository_pull_requests: { path: ["repos", "prs"], target: "repository" },
  list_agents: { path: ["agents"] },
  read_pull_request_files: { path: ["pr", "files"], target: "pr" },
  read_reviewed_files: { path: ["pr", "reviewed"], target: "pr" },
  read_file_contents: { path: ["pr", "file"], target: "pr" },
  read_timeline: { path: ["pr", "timeline"], target: "pr" },
  read_threads: { path: ["pr", "threads"], target: "pr" },
  read_checks: { path: ["pr", "checks"], target: "pr" },
  read_conversation: { path: ["pr", "conversation"], target: "pr" },
  read_stack: { path: ["pr", "stack"], target: "pr" },
  read_pull_request_action_candidates: { path: ["pr", "candidates"], target: "pr" },
  list_reviews: { path: ["guide", "list"] },
  list_guide_revisions: { path: ["guide", "revisions"], target: "pr" },
  read_guide_revision: { path: ["guide", "revision"], target: "pr" },
  read_guide_progress: { path: ["guide", "progress"], target: "pr" },
  read_review_diff: { path: ["pr", "diff"], target: "pr" },
  read_guide_duration: { path: ["guide", "duration"] },
  read_guide_settings: { path: ["guide", "settings"], target: "pr" },
  read_guide_scope: { path: ["guide", "scope"] },
  list_guide_repositories: { path: ["guide", "repositories"] },
  find_guide_repository: { path: ["guide", "repository"], target: "repository" },
  list_fixes: { path: ["fix", "list"] },
  read_fix_turn: { path: ["fix", "turn"], target: "pr" },
  read_fix_diff: { path: ["fix", "diff"], target: "pr" },
  read_fix_patch: { path: ["fix", "patch"], target: "pr" },
  read_fix_access: { path: ["fix", "access"], target: "pr" },
  read_settings: { path: ["settings"] },
  close_pull_request_tab: { path: ["tabs", "close"], target: "pr" },
  focus_pull_request_tab: { path: ["tabs", "focus"], target: "pr" },
  reorder_pull_request_tabs: { path: ["tabs", "reorder"] },
  save_inbox_filters: { path: ["inbox", "filters", "save"] },
  save_pull_request_guide_settings: { path: ["guide", "settings", "save"], target: "pr" },
  edit_review_comment: { path: ["comments", "edit"], target: "pr" },
  move_review_comment: { path: ["comments", "move"], target: "pr" },
  mark_files_reviewed: { path: ["pr", "reviewed", "set"], target: "pr" },
  list_local_guides: { path: ["local", "list"] },
  read_local_guide: { path: ["local", "read"], target: "local" },
  wait_for_local_guide: { path: ["local", "wait"], target: "local" },
  generate_local_guide: { path: ["local", "guide"], target: "local" },
  stop_local_guide: { path: ["local", "stop"], target: "local" },
} satisfies Record<ToolName, CommandMapping>;

export const flagName = (key: string) =>
  ({
    accountId: "account",
    instance: "agent",
    options: "option",
    what: "for",
    timeoutSeconds: "timeout",
    clientRequestId: "request-id",
    repository: "repo",
  })[key] ?? key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const commandParameters = (name: ToolName, mapping: CommandMapping) => {
  const ast = SchemaAST.toEncoded(toolkit.tools[name].parametersSchema.ast);
  if (ast._tag !== "Objects") return [];
  const positional =
    mapping.target === "pr"
      ? ["url", "owner", "repo", "number"]
      : mapping.target === "repository"
        ? ["owner", "repo"]
        : [];
  return ast.propertySignatures.flatMap((field) =>
    typeof field.name !== "string" || positional.includes(field.name)
      ? []
      : [{ key: field.name, name: flagName(field.name), ast: field.type }],
  );
};

export const mappings: ReadonlyArray<readonly [ToolName, CommandMapping]> = Object.entries(
  commandMap,
).map(([name, mapping]) => {
  const tool = Object.values(toolkit.tools).find((tool) => tool.name === name);
  if (tool === undefined) throw new Error(`No outside tool for ${name}.`);
  return [tool.name, mapping];
});
