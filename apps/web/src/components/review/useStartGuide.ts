import type { AccountId, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { generateReview } from "~/rpc/client";

import { storeSnapshot } from "./reviewCache";

/**
 * Starts a guide with the review's own agent or the default from Settings > Guides,
 * from anywhere (inbox row, command palette, Cmd+G). `open` shows its Guide tab.
 */
export function useStartGuide() {
  const client = useQueryClient();
  const workspace = useWorkspace();
  const mutation = useMutation({
    mutationFn: (input: { key: PullRequestKey; accountId: AccountId; open: boolean }) =>
      generateReview(input.key, input.accountId),
    onSuccess: (snapshot, input) => {
      storeSnapshot(client, snapshot);
      if (input.open) {
        useWorkspaceSession.getState().rememberTab(input.key, "guide");
        workspace.open(input.key, input.accountId);
      } else
        toastManager.add({
          title: "Writing a guide",
          description: "It runs in the background. prkit tells you when it is ready.",
          type: "success",
        });
    },
    onError: (error, input) =>
      toastManager.add({
        title: "Couldn't start the guide",
        description: error.message,
        type: "error",
        actionProps: { children: "Retry", onClick: () => mutation.mutate(input) },
      }),
  });
  return {
    start: (key: PullRequestKey, accountId: AccountId, open: boolean) =>
      mutation.mutate({ key, accountId, open }),
    pending: mutation.isPending,
  };
}
