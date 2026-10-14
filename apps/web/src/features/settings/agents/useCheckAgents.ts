import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getAgentCatalog } from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

/** Asks the server to look at both agents' logins again, for after the user ran a fix. */
export function useCheckAgents() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getAgentCatalog(true),
    onSuccess: (catalog) => client.setQueryData(agentCatalogQuery.queryKey, catalog),
  });
}
