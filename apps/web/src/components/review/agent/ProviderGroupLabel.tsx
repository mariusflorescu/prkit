import type { AgentCatalog, AgentCatalogEntry } from "@prkit/contracts";

import { showsInstance } from "./agentSelection";
import { InstanceMarker } from "./InstanceMarker";
import { ProviderIcon } from "./ProviderIcon";

/** An instance's heading in the model list: the login it runs on, or the command that fixes it. */
export function ProviderGroupLabel({
  provider,
  catalog,
}: {
  provider: AgentCatalogEntry;
  catalog: AgentCatalog;
}) {
  const state = provider.state;
  return (
    <>
      <span className="flex items-center gap-1.5">
        <ProviderIcon kind={provider.kind} className="size-3" />
        <span className="font-medium text-foreground/80">{provider.label}</span>
        {showsInstance(catalog, provider) && <InstanceMarker entry={provider} />}
        <span className="truncate">{state._tag === "ready" ? state.detail : "Not ready"}</span>
      </span>
      {state._tag === "unavailable" && (
        <span className="mt-0.5 block text-pretty">
          {state.message}
          {state.fix !== null && (
            <>
              {" "}
              Run{" "}
              <code className="rounded bg-muted px-1 font-mono break-all text-foreground">
                {state.fix}
              </code>
            </>
          )}
        </span>
      )}
    </>
  );
}
