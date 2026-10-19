import type { AgentSelection, LocalReviewKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import {
  generateLocalReview,
  removeLocalReview,
  retryLocalReview,
  stopLocalReview,
} from "~/rpc/client";
import { localReviewProblemQuery } from "~/rpc/queries";

import { forgetLocalReview, storeLocalSnapshot } from "./localReviewCache";

/**
 * Run again, Stop, Retry and Remove for one local review. Run again says so quietly when it
 * found nothing new or a guide already being written, since neither changes the page. A run
 * spends the user's agent subscription, so Run again and Retry start none while prkit can't
 * read the review, whatever asked for it (a toast or a Retry from before included).
 */
export function useLocalReviewActions(key: LocalReviewKey) {
  const client = useQueryClient();
  const readable = <A>(run: () => Promise<A>) =>
    client.getQueryData(localReviewProblemQuery(key).queryKey) == null
      ? run()
      : Promise.reject(new Error("prkit couldn't read this local review, so it started no run."));
  const generate = useMutation({
    mutationFn: (input: { agent?: AgentSelection; regenerate?: boolean }) =>
      readable(() => generateLocalReview(key, input)),
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
    mutationFn: () => readable(() => retryLocalReview(key)),
    onSuccess: (snapshot) => storeLocalSnapshot(client, snapshot),
  });
  const remove = useMutation({
    mutationFn: () => removeLocalReview(key),
    onSuccess: () => forgetLocalReview(client, key),
  });
  return { generate, stop, retry, remove };
}
