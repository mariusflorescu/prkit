import type { AgentInstanceId } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { signOutAgent } from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

/** Signs out the login prkit holds for an agent. The user's own login is a different one and stays. */
export function ProviderSignOut({ instance }: { instance: AgentInstanceId }) {
  const client = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => signOutAgent(instance),
    onSuccess: (catalog) => client.setQueryData(agentCatalogQuery.queryKey, catalog),
  });
  return (
    <span className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        size="xs"
        variant="outline"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        {signOut.isPending
          ? "Signing out…"
          : signOut.error === null
            ? "Sign out prkit's login"
            : "Try again"}
      </Button>
      {signOut.error !== null && (
        <span role="alert" className="text-xs text-error-foreground">
          {signOut.error.message}
        </span>
      )}
    </span>
  );
}
