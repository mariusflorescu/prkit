import type { CursorSdkInstallProgress } from "@prkit/contracts";
import {
  skipToken,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { getAgentCatalog, installCursor } from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

export type CursorInstallState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "installing"; readonly progress: CursorSdkInstallProgress | null }
  | { readonly _tag: "failed"; readonly message: string };

const installKey = ["cursorInstall"] as const;
const progressKey = ["cursorInstall", "progress"] as const;

/**
 * Cursor support is one download per machine, shared by every Cursor agent: each card and the
 * Add-agent dialog follow the same install through its mutation key, and its progress lives in
 * the query cache so a card opened mid-download shows how far it got.
 */
export function useCursorInstall() {
  const client = useQueryClient();
  const install = useMutation({
    mutationKey: installKey,
    mutationFn: async () => {
      client.setQueryData<CursorSdkInstallProgress | null>(progressKey, null);
      await installCursor((progress) =>
        client.setQueryData<CursorSdkInstallProgress | null>(progressKey, progress),
      );
      client.setQueryData(agentCatalogQuery.queryKey, await getAgentCatalog(true));
    },
  });
  const progress = useQuery<CursorSdkInstallProgress | null>({
    queryKey: progressKey,
    queryFn: skipToken,
    gcTime: Infinity,
  }).data;
  const latest = useMutationState({
    filters: { mutationKey: installKey },
    select: (mutation) => mutation.state,
  }).at(-1);
  const state: CursorInstallState =
    latest?.status === "pending"
      ? { _tag: "installing", progress: progress ?? null }
      : latest?.status === "error"
        ? {
            _tag: "failed",
            message: latest.error?.message ?? "Installing Cursor support stopped.",
          }
        : { _tag: "idle" };
  return { state, start: () => install.mutate() };
}
