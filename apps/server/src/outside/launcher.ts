/** Quotes one word for `/bin/sh`. */
const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * `$PRKIT_HOME/bin/prkit-mcp`: runs this server's own entry as Node in bridge mode, the way the
 * desktop app starts the server (`ELECTRON_RUN_AS_NODE=1 <binary> <entry>`), with this home
 * baked in. It holds no secret: the bridge reads the port and token from the discovery file.
 * Written on every launch, so it follows the app when it moves or updates.
 */
export const launcherScript = (home: string) => {
  const entry = process.argv[1] ?? "";
  return [
    "#!/bin/sh",
    "# prkit's MCP server for your own coding agent (Settings > Outside agents).",
    "# prkit writes this file on every launch. It holds no secret.",
    `PRKIT_HOME=${shellQuote(home)}`,
    "ELECTRON_RUN_AS_NODE=1",
    "export PRKIT_HOME ELECTRON_RUN_AS_NODE",
    `exec ${shellQuote(process.execPath)} ${shellQuote(entry)} mcp-bridge "$@"`,
    "",
  ].join("\n");
};
