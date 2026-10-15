import { makeOutsideToolkit } from "../mcp/outside/tools.ts";

export const toolkit = makeOutsideToolkit(() => true);
export type ToolName = keyof typeof toolkit.tools;

type CommandMapping = {
  readonly path: readonly [string, ...string[]];
  readonly target?: boolean;
};

export const commandMap = {
  prkit_status: { path: ["status"] },
  list_inbox: { path: ["inbox"] },
  list_open_pull_requests: { path: ["open-prs"] },
  read_pull_request: { path: ["pr", "read"], target: true },
  open_pull_request: { path: ["pr", "open"], target: true },
  read_guide: { path: ["guide", "read"], target: true },
  generate_guide: { path: ["guide", "generate"], target: true },
  stop_guide: { path: ["guide", "stop"], target: true },
  list_review_comments: { path: ["comments", "list"], target: true },
  add_review_comment: { path: ["comments", "add"], target: true },
  read_fix: { path: ["fix", "read"], target: true },
  send_to_fix_agent: { path: ["fix", "send"], target: true },
  ask_fix_agent_to_change: { path: ["fix", "change"], target: true },
  stop_fix: { path: ["fix", "stop"], target: true },
  retry_fix: { path: ["fix", "retry"], target: true },
  resolve_conflicts: { path: ["fix", "resolve"], target: true },
  wait_for: { path: ["wait"], target: true },
} satisfies Record<ToolName, CommandMapping>;

export const flagName = (key: string) =>
  ({
    accountId: "account",
    instance: "agent",
    options: "option",
    what: "for",
    timeoutSeconds: "timeout",
    clientRequestId: "request-id",
  })[key] ?? key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const mappings: ReadonlyArray<readonly [ToolName, CommandMapping]> = Object.entries(
  commandMap,
).map(([name, mapping]) => {
  const tool = Object.values(toolkit.tools).find((tool) => tool.name === name);
  if (tool === undefined) throw new Error(`No outside tool for ${name}.`);
  return [tool.name, mapping];
});
