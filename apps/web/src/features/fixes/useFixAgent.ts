import {
  type AgentSelection,
  findAgentModel,
  keepsConversation,
  type PullRequestKey,
  selectionProblem,
  sessionSelection,
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
      : {
          instance: session.instance,
          kind: session.provider,
          model: session.model,
          options: session.modelOptions,
        };
  const selection =
    picked ??
    (catalog.data === undefined || settings.data === undefined
      ? null
      : sessionSelection(catalog.data, own, settings.data.defaultAgent));
  const problem =
    catalog.data === undefined || selection === null
      ? null
      : selectionProblem(catalog.data, selection);
  const model =
    catalog.data === undefined || selection === null
      ? undefined
      : findAgentModel(catalog.data, selection.instance, selection.model);
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
    /** Picking an agent in another conversation group than the session's starts a new conversation. */
    switching:
      session?.status._tag === "active" &&
      catalog.data !== undefined &&
      selection !== null &&
      !keepsConversation(catalog.data, session.instance, selection.instance),
  };
}
