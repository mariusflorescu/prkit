import * as Context from "effect/Context";

/**
 * The outside agent a call comes from, by its cleaned name; null for everything prkit or
 * the owner starts. Set by the outside MCP endpoint around one service call, and read where
 * a guide attempt or a fix turn is recorded, so that work says who started it.
 */
export const StartedBy = Context.Reference<string | null>(
  "@prkit/server/outside/StartedBy/StartedBy",
  { defaultValue: () => null },
);
