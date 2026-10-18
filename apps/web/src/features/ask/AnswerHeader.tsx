import { type AnswerAgent, type AnswerBasis, findAgentEntry } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { InstanceMarker } from "~/components/review/agent/InstanceMarker";
import { ProviderIcon } from "~/components/review/agent/ProviderIcon";
import { agentName, showsInstance } from "~/components/review/agent/agentSelection";
import { agentCatalogQuery } from "~/rpc/queries";

import { basisWords } from "./askPresentation";

/** The agent that answers, with its marker, and where its conversation came from. */
export function AnswerHeader({
  agent,
  basis,
  answered,
}: {
  agent: AnswerAgent;
  basis: AnswerBasis;
  answered: boolean;
}) {
  const catalog = useQuery(agentCatalogQuery).data;
  const entry = catalog === undefined ? undefined : findAgentEntry(catalog, agent.instance);
  const name = agentName(catalog, { instance: agent.instance, provider: agent.kind });
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <ProviderIcon kind={agent.kind} className="size-3.5 text-foreground" />
      <span className="font-medium text-foreground">{answered ? `${name} answered` : name}</span>
      {entry !== undefined && showsInstance(catalog, entry) && <InstanceMarker entry={entry} />}
      <span aria-hidden="true">·</span>
      <span>{basisWords(basis)}</span>
    </p>
  );
}
