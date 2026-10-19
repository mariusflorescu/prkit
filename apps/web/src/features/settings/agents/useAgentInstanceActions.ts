import type { AgentCatalog, AgentInstanceConfig, AgentInstanceId } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import {
  createAgentInstance,
  getAgentCatalog,
  removeAgentInstance,
  resetAgentInstance,
  updateAgentInstance,
} from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

/**
 * Every change to one agent instance from Settings > Agents. Each stores the catalog the server
 * answers with and says it worked in a toast; a failed change shows its error where it was made.
 * `check` reads only this instance's login again, and says in a toast when it can't.
 */
export function useAgentInstanceActions() {
  const client = useQueryClient();
  const store = (catalog: AgentCatalog) => client.setQueryData(agentCatalogQuery.queryKey, catalog);

  const create = useMutation({
    mutationFn: createAgentInstance,
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({
        title: "Agent added",
        description: `${config.label} (${config.id}) is ready to set up.`,
        type: "success",
      });
    },
  });
  const update = useMutation({
    mutationFn: updateAgentInstance,
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Saved ${config.label}`, type: "success" });
    },
  });
  const toggle = useMutation({
    mutationFn: (config: AgentInstanceConfig) => updateAgentInstance(config),
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({
        title: config.enabled ? `Turned on ${config.label}` : `Turned off ${config.label}`,
        type: "success",
      });
    },
  });
  const remove = useMutation({
    mutationFn: (config: AgentInstanceConfig) => removeAgentInstance(config.id),
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Removed ${config.label}`, type: "success" });
    },
  });
  const reset = useMutation({
    mutationFn: (config: AgentInstanceConfig) => resetAgentInstance(config.id),
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Reset ${config.label} to its defaults`, type: "success" });
    },
  });
  const check = useMutation({
    mutationFn: (instance: AgentInstanceId) => getAgentCatalog(true, instance),
    onSuccess: store,
    onError: (error) =>
      toastManager.add({
        title: "Couldn't check the agent",
        description: error.message,
        type: "error",
      }),
  });
  return { create, update, toggle, remove, reset, check };
}
