import type { AgentInstanceId } from "@prkit/contracts";
import {
  skipToken,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { getAgentCatalog, signInAgent } from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

/** How far a running sign-in got: its page opening, the page open in the browser, or the new login being read. */
type SignInStep =
  | { readonly _tag: "opening" }
  | { readonly _tag: "browser"; readonly url: string }
  | { readonly _tag: "checking" };

export type AgentSignInState =
  | { readonly _tag: "idle" }
  | SignInStep
  | { readonly _tag: "failed"; readonly message: string };

const signInKey = (instance: AgentInstanceId) => ["agentSignIn", instance] as const;
const stepKey = (instance: AgentInstanceId) => ["agentSignIn", instance, "step"] as const;

/**
 * prkit's own sign-in for an agent. Settings and the model list share it through its mutation
 * key, so closing the list while the browser is open doesn't lose it, and Cancel works from
 * either: the mutation's variables are the controller that stops it.
 */
export function useAgentSignIn(instance: AgentInstanceId) {
  const client = useQueryClient();
  const signIn = useMutation({
    mutationKey: signInKey(instance),
    mutationFn: async (controller: AbortController) => {
      const reached = (step: SignInStep) =>
        client.setQueryData<SignInStep>(stepKey(instance), step);
      reached({ _tag: "opening" });
      const result = await signInAgent(
        instance,
        (url) => {
          reached({ _tag: "browser", url });
          window.open(url, "_blank", "noopener,noreferrer");
        },
        controller.signal,
      );
      if (result === "signed-in") {
        // Pending until the catalog has the new login, so the button doesn't come back meanwhile.
        reached({ _tag: "checking" });
        client.setQueryData(agentCatalogQuery.queryKey, await getAgentCatalog(true));
      }
      return result;
    },
  });
  const step = useQuery<SignInStep>({
    queryKey: stepKey(instance),
    queryFn: skipToken,
    gcTime: Infinity,
  }).data;
  const latest = useMutationState({
    filters: { mutationKey: signInKey(instance) },
    select: (mutation) => mutation.state,
  }).at(-1);
  const running =
    latest?.status === "pending" && latest.variables instanceof AbortController
      ? latest.variables
      : null;
  const state: AgentSignInState =
    latest?.status === "pending"
      ? (step ?? { _tag: "opening" })
      : latest?.status === "error"
        ? { _tag: "failed", message: latest.error?.message ?? "Signing in stopped. Try again." }
        : { _tag: "idle" };
  return {
    state,
    start: () => {
      running?.abort();
      signIn.mutate(new AbortController());
    },
    cancel: () => running?.abort(),
  };
}
