import type { AccountId, AgentSelection, GuidanceEdit, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { generateReview, retryReview, stopReview } from "~/rpc/client";
import { GUIDE_CONFIG_KEY } from "~/rpc/queries";

import { storeSnapshot } from "./reviewCache";

export function useReviewActions(key: PullRequestKey) {
  const client = useQueryClient();
  const onSuccess = (snapshot: Parameters<typeof storeSnapshot>[1]) =>
    storeSnapshot(client, snapshot);
  const generate = useMutation({
    /** Without `agent` the server uses the review's own agent or the default in Settings > Guides. */
    mutationFn: (input: {
      accountId: AccountId;
      agent?: AgentSelection;
      guidance?: GuidanceEdit;
    }) =>
      generateReview(key, input.accountId, {
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
      }),
    onSuccess: (snapshot, input) => {
      onSuccess(snapshot);
      // The server saved the new guidance, so the next setup starts from its version.
      if (input.guidance !== undefined)
        void client.invalidateQueries({ queryKey: GUIDE_CONFIG_KEY });
    },
  });
  const stop = useMutation({ mutationFn: () => stopReview(key), onSuccess });
  const retry = useMutation({ mutationFn: () => retryReview(key), onSuccess });
  return { generate, stop, retry };
}
