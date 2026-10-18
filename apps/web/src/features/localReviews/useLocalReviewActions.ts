import type { AgentSelection, LocalReviewKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import {
  generateLocalReview,
  removeLocalReview,
  retryLocalReview,
  stopLocalReview,
} from "~/rpc/client";

import { forgetLocalReview, storeLocalSnapshot } from "./localReviewCache";

/**
 * Run again, Stop, Retry and Remove for one local review. Run again says so quietly when it
 * found nothing new or a guide already being written, since neither changes the page.
 */
export function useLocalReviewActions(key: LocalReviewKey) {
  const client = useQueryClient();
  const generate = useMutation({
    mutationFn: (input: { agent?: AgentSelection; regenerate?: boolean }) =>
      generateLocalReview(key, input),
    onSuccess: (result) => {
      storeLocalSnapshot(client, result.snapshot);
      const latest = result.snapshot.revisions.at(-1)?.revision;
      if (result.outcome === "unchanged")
        toastManager.add({
          title:
            latest === undefined ? "Nothing changed" : `Nothing changed since revision ${latest}`,
          description: "The guide is current.",
          actionProps: {
            children: "Write it again",
            onClick: () => generate.mutate({ regenerate: true }),
          },
        });
      if (result.outcome === "running")
        toastManager.add({ title: "A guide is already being written" });
    },
  });
  const stop = useMutation({
    mutationFn: () => stopLocalReview(key),
    onSuccess: (snapshot) => storeLocalSnapshot(client, snapshot),
  });
  const retry = useMutation({
    mutationFn: () => retryLocalReview(key),
    onSuccess: (snapshot) => storeLocalSnapshot(client, snapshot),
  });
  const remove = useMutation({
    mutationFn: () => removeLocalReview(key),
    onSuccess: () => forgetLocalReview(client, key),
  });
  return { generate, stop, retry, remove };
}
