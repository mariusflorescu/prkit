import {
  type AccountId,
  type AgentSelection,
  type GuidanceEdit,
  type PullRequestKey,
  refFromKey,
} from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { generateStackGuides } from "~/rpc/client";
import { GUIDE_CONFIG_KEY } from "~/rpc/queries";

const SKIPPED = {
  "has-guide": "already has a guide",
  running: "is being written",
  "not-open": "isn't open",
};

/**
 * Starts guides for layers of a stack with one agent. Each started layer opens as a
 * tab on its Guide, so its progress shows there, and the PR it was started from stays
 * in front. The server announces the batch once, when the last guide finishes.
 */
export function useStartStackGuides() {
  const client = useQueryClient();
  const workspace = useWorkspace();
  const mutation = useMutation({
    mutationFn: generateStackGuides,
    onSuccess: (result, input) => {
      // The server saved the new guidance on the chosen layers, so setups start from its version.
      if (input.guidance !== undefined)
        void client.invalidateQueries({ queryKey: GUIDE_CONFIG_KEY });
      const open = new Set(workspace.data?.open.map((row) => row.key));
      for (const key of result.started) {
        useWorkspaceSession.getState().rememberTab(key, "guide");
        if (!open.has(key)) workspace.send({ kind: "open", key, accountId: input.accountId });
      }
      if (result.started.some((key) => !open.has(key)))
        workspace.send({ kind: "activate", key: input.key });
      const skipped = result.skipped.map(
        (row) => `#${refFromKey(row.key)?.number ?? "?"} ${SKIPPED[row.reason]}`,
      );
      const count = result.started.length;
      toastManager.add({
        title:
          count === 0
            ? "No guides to write"
            : `Writing ${count} stack guide${count === 1 ? "" : "s"}`,
        description:
          skipped.length > 0
            ? `${skipped.join(" · ")}.`
            : "prkit tells you when all of them are ready.",
        type: count === 0 ? "info" : "success",
      });
    },
    onError: (error, input) =>
      toastManager.add({
        title: "Couldn't start the stack's guides",
        description: error.message,
        type: "error",
        actionProps: { children: "Retry", onClick: () => mutation.mutate(input) },
      }),
  });
  return {
    start: (input: {
      readonly key: PullRequestKey;
      readonly accountId: AccountId;
      readonly layers: readonly [number, ...number[]];
      readonly regenerate: boolean;
      readonly agent?: AgentSelection;
      readonly guidance?: GuidanceEdit;
    }) => mutation.mutate(input),
    pending: mutation.isPending,
    /** How many layers the start in flight asked for, while the live count drops as they start. */
    asked: mutation.isPending ? mutation.variables.layers.length : null,
    error: mutation.error,
  };
}
