import {
  type AgentSelection,
  effectiveSelection,
  findAgentModel,
  type PullRequestKey,
  selectionProblem,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAgentCatalog } from "~/rpc/client";
import { agentCatalogQuery, fixerQuery, guideSettingsQuery } from "~/rpc/queries";

/**
 * Who a fix turn runs on: the one the user picked, else the PR's session agent,
 * else the default from Settings > Agents, checked against the catalog.
 */
export function useFixAgent(key: PullRequestKey, picked: AgentSelection | null) {
  const client = useQueryClient();
  const catalog = useQuery(agentCatalogQuery);
  const settings = useQuery(guideSettingsQuery);
  const fixer = useQuery(fixerQuery(key));
  const checkAgain = useMutation({
    mutationFn: () => getAgentCatalog(true),
    onSuccess: (data) => client.setQueryData(agentCatalogQuery.queryKey, data),
  });
  const session = fixer.data?.fixer;
  const own =
    session?.model == null
      ? null
      : { provider: session.provider, model: session.model, options: session.modelOptions };
  const selection =
    picked ??
    (catalog.data === undefined || settings.data === undefined
      ? null
      : effectiveSelection(catalog.data, own ?? settings.data.defaultAgent));
  const problem =
    catalog.data === undefined || selection === null
      ? null
      : selectionProblem(catalog.data, selection);
  const model =
    catalog.data === undefined || selection === null
      ? undefined
      : findAgentModel(catalog.data, selection.provider, selection.model);
  return {
    catalog: catalog.data,
    selection,
    problem,
    model,
    loading: catalog.isPending || settings.isPending,
    error: catalog.error ?? settings.error,
    retry: () => {
      void catalog.refetch();
      void settings.refetch();
    },
    checkAgain,
    /** The session's own agent, so changing it can say it starts a new conversation. */
    sessionProvider: session?.status._tag === "active" ? session.provider : null,
  };
}
