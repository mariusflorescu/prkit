import { type AgentInstanceId, findAgentEntry } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { AgentSignIn } from "~/components/review/agent/AgentSignIn";
import { useAgentSignIn } from "~/components/review/agent/useAgentSignIn";
import { agentCatalogQuery } from "~/rpc/queries";

/**
 * prkit's own ChatGPT sign-in for a Codex instance just added, started at once. It's the same
 * sign-in as the agent's card, so closing the dialog doesn't stop it.
 */
export function ChatGptSignIn({ instance }: { instance: AgentInstanceId }) {
  const { start } = useAgentSignIn(instance);
  const catalog = useQuery(agentCatalogQuery);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, [start]);
  const entry = catalog.data === undefined ? undefined : findAgentEntry(catalog.data, instance);
  if (entry?.state._tag === "ready")
    return (
      <p role="status" className="text-xs text-success-foreground">
        Signed in · {entry.state.detail}
      </p>
    );
  return <AgentSignIn instance={instance} />;
}
