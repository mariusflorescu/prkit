import type { OutsideAgentsSettings } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { resetOutsideAgents, updateOutsideAgents } from "~/rpc/client";
import { outsideAgentsQuery } from "~/rpc/queries";

/** The outside agents' switch, level and clients, and the two ways to change them. */
export function useOutsideAgents() {
  const client = useQueryClient();
  const state = useQuery(outsideAgentsQuery);
  const update = useMutation({
    mutationFn: (settings: OutsideAgentsSettings) => updateOutsideAgents(settings),
    onSuccess: (next) => {
      client.setQueryData(outsideAgentsQuery.queryKey, next);
      toastManager.add({
        title: !next.enabled
          ? "Outside agents are off"
          : next.access === "work"
            ? "Outside agents can read and start work"
            : "Outside agents can read",
        type: "success",
      });
    },
  });
  const reset = useMutation({
    mutationFn: resetOutsideAgents,
    onSuccess: (next) => {
      client.setQueryData(outsideAgentsQuery.queryKey, next);
      toastManager.add({
        title: "Access reset",
        description: "prkit made a new key. Anything using a copied key stops working.",
        type: "success",
      });
    },
  });
  return { state, update, reset };
}
