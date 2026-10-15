import { type AgentCatalog, type AgentSelection, findAgentEntry } from "@prkit/contracts";

/**
 * Cursor fixes edit files only: its SDK approves every command on its own, so prkit gives it no
 * shell and it never runs a repository's scripts (agents/cursor/tools.ts on the server).
 */
export const CURSOR_SCRIPTS_REASON =
  "Cursor fixes edit files only: Cursor can't ask before each command, so it never runs this repository's scripts.";

/** Whether the fix agent picked or saved for a PR is a Cursor one. */
export const runsOnCursor = (catalog: AgentCatalog | undefined, selection: AgentSelection | null) =>
  catalog !== undefined &&
  selection !== null &&
  findAgentEntry(catalog, selection.instance)?.kind === "cursor";
