import { outsideSetupCommands } from "@prkit/contracts";

import { FixCommand } from "~/features/settings/agents/FixCommand";

/** The one command that adds prkit to each client. No secret is in it. */
export function OutsideSetupCommands({ launcher }: { launcher: string }) {
  const commands = outsideSetupCommands(launcher);
  return (
    <div className="border-t border-border/60 py-3">
      <p className="text-sm">Add prkit to your client</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Run one of these once in a terminal. Other MCP clients start the same command over stdio.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">Claude Code</p>
      <FixCommand command={commands.claude} />
      <p className="mt-3 text-xs text-muted-foreground">Codex</p>
      <FixCommand command={commands.codex} />
    </div>
  );
}
