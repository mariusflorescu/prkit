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
 * answers with and says how it went in a toast; `check` reads only this instance's login again.
 */
export function useAgentInstanceActions() {
  const client = useQueryClient();
  const store = (catalog: AgentCatalog) => client.setQueryData(agentCatalogQuery.queryKey, catalog);
  const failed = (title: string) => (error: Error) =>
    toastManager.add({ title, description: error.message, type: "error" });

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
    onError: failed("Couldn't add the agent"),
  });
  const update = useMutation({
    mutationFn: updateAgentInstance,
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Saved ${config.label}`, type: "success" });
    },
    onError: failed("Couldn't save the agent"),
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
    onError: failed("Couldn't change the agent"),
  });
  const remove = useMutation({
    mutationFn: (config: AgentInstanceConfig) => removeAgentInstance(config.id),
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Removed ${config.label}`, type: "success" });
    },
    onError: failed("Couldn't remove the agent"),
  });
  const reset = useMutation({
    mutationFn: (config: AgentInstanceConfig) => resetAgentInstance(config.id),
    onSuccess: (catalog, config) => {
      store(catalog);
      toastManager.add({ title: `Reset ${config.label} to its defaults`, type: "success" });
    },
    onError: failed("Couldn't reset the agent"),
  });
  const check = useMutation({
    mutationFn: (instance: AgentInstanceId) => getAgentCatalog(true, instance),
    onSuccess: store,
    onError: failed("Couldn't check the agent"),
  });
  return { create, update, toggle, remove, reset, check };
}
